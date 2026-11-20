// git.ts — git object model, packfile codec, and smart-HTTP (upload-pack v0/v2, receive-pack v0).
//
// Written from scratch against the kit's check/client files (the spec). Stdlib only
// (node:crypto, node:zlib, node:http). No clocks, no randomness anywhere: object ids are
// content hashes and every byte the server emits is a pure function of the store.
//
// Conventions a caller (app.ts / rest.ts) must know:
// - buildCommit(tree, parents, author, committer, message): `author`/`committer` are the
//   COMPLETE line values verbatim, e.g. "ada iversen <ada@example.invalid> 1700000000 +0000"
//   (name/email + unix seconds + timezone). parseCommit returns those same full values, so
//   parse(build(x)) round-trips. git.ts itself never invents a commit or a timestamp.
// - handleGit derives owner/repo/service from req.url when the arguments are empty strings;
//   the `service` argument is only a hint. It reads the request body itself and answers
//   404 JSON for a missing repo, 401 JSON {"message":"Bad credentials"} for a bad/missing
//   Bearer token (only enforced when MAKEFUN_SHOP_TOKEN is set and non-empty).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitObject, Oid, Repo, Store } from './store.ts';

/** The all-zero object id: an unborn branch's old/new value. */
export const ZERO_OID = '0'.repeat(40);

const AGENT = 'makefun-git/1.0';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Largest sideband data chunk: pkt-line max 65520 minus 4 header bytes minus 1 band byte. */
const SIDEBAND_CHUNK = 65515;
const HEX40 = /^[0-9a-f]{40}$/;

function isOid(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------------------------------------
// object ids
// ---------------------------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObject['type'], data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// commit / tree
// ---------------------------------------------------------------------------------------------

export function parseCommit(data: Buffer): {
  tree: Oid;
  parents: Oid[];
  author: string;
  committer: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: Oid[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isOid(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message };
}

/**
 * Build a commit object's bytes. `author`/`committer` are the full line values verbatim
 * (see the header comment). Layout matches the kit client byte-for-byte:
 * `tree <oid>\n` + `parent <oid>\n`* + `author <author>\ncommitter <committer>\n\n<message>`.
 */
export function buildCommit(
  tree: Oid,
  parents: Oid[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  if (!isOid(tree)) throw new Error('buildCommit needs a valid tree id');
  for (const parent of parents) if (!isOid(parent)) throw new Error('buildCommit needs valid parent ids');
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: Oid }[] {
  const entries: { mode: string; name: string; oid: Oid }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(
  a: { mode: string; name: string },
  b: { mode: string; name: string },
): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: { mode: string; name: string; oid: Oid }[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isOid(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object's headers (internal: peeling + reachability). */
function parseTagData(data: Buffer): {
  object: Oid;
  type: string;
  tag: string;
  tagger: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return {
    object,
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Follow tag objects until a non-tag object (or a missing object); returns the final oid. */
function peelToNonTag(repo: Repo, oid: Oid): Oid {
  let current = oid;
  const seen = new Set<Oid>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTagData(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** Add a tree object and everything under it (recursively) to `into`; gitlinks are skipped. */
function addTreeClosure(repo: Repo, treeOid: Oid, into: Map<Oid, GitObject>): void {
  const stack: Oid[] = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    if (object.type !== 'tree') {
      into.set(oid, object);
      continue;
    }
    into.set(oid, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '160000') continue; // gitlink: a commit this repo does not hold
      stack.push(entry.oid);
    }
  }
}

/** Add one object and, for commits/tags, its closure to `into`. Used by collectReachable. */
function addReachableOne(
  repo: Repo,
  root: Oid,
  into: Map<Oid, GitObject>,
  visiting: Set<Oid>,
): void {
  const stack: Oid[] = [root];
  while (stack.length) {
    const oid = stack.pop()!;
    if (into.has(oid) || visiting.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    visiting.add(oid);
    into.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addTreeClosure(repo, commit.tree, into);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTagData(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
    visiting.delete(oid);
  }
}

export function collectReachable(repo: Repo, tips: Oid[]): Map<Oid, GitObject> {
  const out = new Map<Oid, GitObject>();
  const visiting = new Set<Oid>();
  for (const tip of tips) {
    if (!isOid(tip)) continue;
    addReachableOne(repo, tip, out, visiting);
  }
  return out;
}

export function isAncestor(repo: Repo, ancestor: Oid, tip: Oid): boolean {
  const target = peelToNonTag(repo, ancestor);
  let current = peelToNonTag(repo, tip);
  if (target === current) return true;
  const seen = new Set<Oid>();
  const stack: Oid[] = [current];
  while (stack.length) {
    current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packfile read (v2/v3, ofs-delta + ref-delta, zlib)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObject['type'], number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObject['type']>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export function parsePack(buf: Buffer): Map<Oid, GitObject> {
  const buffer = buf;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = sha1Hex(buffer.subarray(0, trailerStart));
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObject['type'];
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<Oid, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObject['type']; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObject['type'];
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (!baseEntry) throw new Error(`ref-delta base ${wanted} is not in the pack (thin packs are not accepted)`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas)
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObject['type'], size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function buildPack(objects: Map<Oid, GitObject>): Buffer {
  // Sorted by oid so the same object set always yields the same pack bytes.
  const list = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const [, object] of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec (module-private; util.ts owns the shared one, git.ts stays self-contained)
// ---------------------------------------------------------------------------------------------

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload is over the 65520-byte maximum');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode pkt-lines; when `stopAfterFlush`, stops after the first flush and reports `next`. */
function decodePackets(buf: Buffer, stopAfterFlush: boolean): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAfterFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** Wrap bytes as sideband band-1 packets (each a pkt-line: 1 band byte + up to 65515 data bytes). */
function sidebandWrap(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDEBAND_CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('request body exceeds the 10 MiB cap'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  sendBuffer(res, status, 'application/json; charset=utf-8', Buffer.from(text, 'utf8'));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

/** Bearer check against MAKEFUN_SHOP_TOKEN; open when the env var is unset (local dev only). */
function authed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!token) return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

// ---------------------------------------------------------------------------------------------
// refs / advertisement
// ---------------------------------------------------------------------------------------------

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headOid(repo: Repo): Oid {
  return repo.refs.get(headTarget(repo)) ?? ZERO_OID;
}

function sortedRefs(repo: Repo): { name: string; oid: Oid }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit a tag ref peels to, or null when the tag does not resolve to a commit. */
function peeledCommit(repo: Repo, oid: Oid): Oid | null {
  const target = peelToNonTag(repo, oid);
  const object = repo.objects.get(target);
  if (!object || object.type !== 'commit') return null;
  return target;
}

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const symref = `symref=HEAD:${headTarget(repo)}`;
  if (service === 'git-upload-pack') {
    return `${symref} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta ${symref} agent=${AGENT}`;
}

/** The v0 ref advertisement body (with the `# service=` preamble) for either service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(repo, service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    for (const ref of refs) {
      if (!ref.name.startsWith('refs/tags/')) continue;
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body for upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v0 and v2)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: Oid[];
  haves: Oid[];
  shallow: Oid[];
  depth: number | undefined;
}

interface FetchPlan {
  objects: Map<Oid, GitObject>;
  shallow: Oid[];
  unshallow: Oid[];
}

/**
 * Which objects a fetch sends, and the new shallow boundary.
 *
 * - Included commits: breadth-first from the wants, to `depth` generations when given.
 * - Sent objects: the tree/blob closure of the included commits (parents stop the walk),
 *   minus the closure of the haves — where a have-walk stops at the client's old shallow
 *   boundary (its parents are not held by the client, so they must not be subtracted).
 *   This is what makes deepen work: a have that is itself a shallow boundary contributes
 *   only itself + its tree, so its parent is still sent when the depth reaches it.
 * - New boundary: included commits with a parent outside the included set (or no parents),
 *   when a depth was given. Unshallow: old boundary commits now fully included.
 */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const oldShallow = new Set(request.shallow);
  const included = new Map<Oid, GitObject>();
  const includedCommits = new Set<Oid>();

  // Breadth-first over commits, generation 1 = the wants.
  const queue: { oid: Oid; gen: number }[] = [];
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (!object) throw new Error(`want ${want} not found`);
    if (object.type === 'tag') {
      included.set(want, object);
      queue.push({ oid: parseTagData(object.data).object, gen: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 1 });
    } else {
      included.set(want, object);
      if (object.type === 'tree') addTreeClosure(repo, want, included);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, gen } = queue[head];
    if (includedCommits.has(oid)) continue;
    if (request.depth !== undefined && gen > request.depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    includedCommits.add(oid);
    included.set(oid, object);
    const commit = parseCommit(object.data);
    addTreeClosure(repo, commit.tree, included);
    for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // Closure of the haves, stopping at the old shallow boundary.
  const haveClosure = new Map<Oid, GitObject>();
  {
    const visited = new Set<Oid>();
    const walk = (oid: Oid): void => {
      if (visited.has(oid)) return;
      visited.add(oid);
      const object = repo.objects.get(oid);
      if (!object) return;
      haveClosure.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        addTreeClosure(repo, commit.tree, haveClosure);
        if (!oldShallow.has(oid)) for (const parent of commit.parents) walk(parent);
      } else if (object.type === 'tag') {
        walk(parseTagData(object.data).object);
      } else if (object.type === 'tree') {
        addTreeClosure(repo, oid, haveClosure);
      }
    };
    for (const have of request.haves) walk(have);
  }

  const objects = new Map<Oid, GitObject>();
  for (const [oid, object] of included) {
    if (!haveClosure.has(oid)) objects.set(oid, object);
  }

  const shallow: Oid[] = [];
  if (request.depth !== undefined) {
    for (const oid of includedCommits) {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      if (commit.parents.length === 0 || commit.parents.some((p) => !includedCommits.has(p))) {
        shallow.push(oid);
      }
    }
  }
  const unshallow: Oid[] = [];
  for (const oid of oldShallow) {
    if (!includedCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.every((p) => includedCommits.has(p))) unshallow.push(oid);
  }

  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

/** Parse the data lines of an upload-pack request body into a FetchRequest. */
function parseFetchRequest(packets: Packet[]): FetchRequest {
  const wants: Oid[] = [];
  const haves: Oid[] = [];
  const shallow: Oid[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (!isOid(oid)) throw new Error(`fetch wants a bad object id ${JSON.stringify(oid)}`);
      wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (!isOid(oid)) throw new Error(`fetch have is a bad object id ${JSON.stringify(oid)}`);
      haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line.startsWith('deepen-not ')) {
      const ref = line.slice(11).trim();
      if (isOid(ref)) haves.push(ref);
    }
    // command=, agent=, object-format=, thin-pack, no-progress, ofs-delta, filter, done:
    // acknowledged by parsing; no action needed.
  }
  return { wants, haves, shallow, depth };
}

/** ACK the haves the store holds, then `ready`; otherwise `NAK`. (v2 acknowledgments.) */
function ackSection(repo: Repo, haves: Oid[]): Buffer[] {
  const known = haves.filter((oid) => repo.objects.has(oid));
  if (known.length) {
    const parts = known.map((oid) => pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
    return parts;
  }
  return [pktLine('NAK\n')];
}

/** v0 acknowledgments: ACK lines for the haves held, otherwise `NAK` (v0 has no `ready`). */
function ackSectionV0(repo: Repo, haves: Oid[]): Buffer[] {
  const known = haves.filter((oid) => repo.objects.has(oid));
  if (known.length) return known.map((oid) => pktLine(`ACK ${oid}\n`));
  return [pktLine('NAK\n')];
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePackets(body, false);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data');
  const first = lines[0]?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (first === 'command=ls-refs') {
    const args = lines.slice(1).map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
    return lsRefsResponse(repo, args);
  }
  if (first !== 'command=fetch') {
    throw new Error(`unsupported v2 command ${JSON.stringify(first.slice(0, 40))}`);
  }
  const request = parseFetchRequest(packets);
  const plan = planFetch(repo, request);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), ...ackSection(repo, request.haves), pktDelim()];
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'), ...sidebandWrap(pack), pktFlush());
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const refs = sortedRefs(repo).filter(
    (ref) => prefixes.length === 0 || prefixes.some((prefix) => ref.name.startsWith(prefix)),
  );
  const parts: Buffer[] = [];
  if (prefixes.length === 0) {
    if (refs.length === 0) {
      if (wantUnborn) {
        parts.push(
          pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`),
        );
      }
    } else {
      const head = headOid(repo);
      parts.push(
        pktLine(`${head} HEAD${wantSymrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`),
      );
    }
  }
  for (const ref of refs) {
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.name.startsWith('refs/tags/')) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePackets(body, false);
  const request = parseFetchRequest(packets);
  const plan = planFetch(repo, request);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [...ackSectionV0(repo, request.haves)];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandWrap(pack), pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: Oid;
  newOid: Oid;
  ref: string;
}

function handleReceivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { packets, next } = decodePackets(body, true);
  const commands: PushCommand[] = [];
  let clientCaps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue; // the flush ends the command list
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCaps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length < 3 || !isOid(fields[0]) || !isOid(fields[1])) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields.slice(2).join(' ') });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');

  // Unpack first: every object the pack carries lands in the store before any ref moves.
  let unpackError: string | null = null;
  const packBytes = body.subarray(next);
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const [, object] of objects) store.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  const reportLines: string[] = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      reportLines.push(`${applyPushCommand(repo, command)}\n`);
    }
  }

  const reportStream = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const sideband = clientCaps.split(' ').includes('side-band-64k');
  const parts: Buffer[] = sideband ? sidebandWrap(reportStream) : [reportStream];
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Apply one push command; returns the report-status line (`ok <ref>` / `ng <ref> <reason>`). */
function applyPushCommand(repo: Repo, command: PushCommand): string {
  const current = repo.refs.get(command.ref);
  if (!command.ref.startsWith('refs/')) return `ng ${command.ref} invalid refname`;
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${command.ref} remote ref does not exist`;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return `ng ${command.ref} old value does not match`;
    }
    repo.refs.delete(command.ref);
    return `ok ${command.ref}`;
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return `ng ${command.ref} already exists`;
    if (!repo.objects.has(command.newOid)) return `ng ${command.ref} object not found`;
    repo.refs.set(command.ref, command.newOid);
    return `ok ${command.ref}`;
  }
  // Update: the old value must match, the new object must exist, and the move must be a
  // fast-forward (the old tip is an ancestor of the new tip, tags peeled to their commit).
  if (current === undefined) return `ng ${command.ref} remote ref does not exist`;
  if (command.oldOid !== current) return `ng ${command.ref} old value does not match`;
  if (!repo.objects.has(command.newOid)) return `ng ${command.ref} object not found`;
  if (!isAncestor(repo, peelToNonTag(repo, current), peelToNonTag(repo, command.newOid))) {
    return `ng ${command.ref} non-fast-forward`;
  }
  repo.refs.set(command.ref, command.newOid);
  return `ok ${command.ref}`;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Serve git smart HTTP under `/{owner}/{repo}.git`.
 *
 * Routes: GET info/refs?service=git-upload-pack|git-receive-pack, POST /git-upload-pack
 * (protocol v2 when the request carries `Git-Protocol: version=2`, else v0),
 * POST /git-receive-pack (v0). Missing repo → 404 JSON on every route; the server stays up.
 * `owner`/`repoName`/`service` are hints — everything is re-derived from req.url when given
 * as empty strings, so the handler works however app.ts wires it.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    let ownerName = owner;
    let repo = repoName;
    if ((!ownerName || !repo) && segments.length >= 2) {
      try {
        ownerName = ownerName || decodeURIComponent(segments[0]);
        let raw = decodeURIComponent(segments[1]);
        if (raw.endsWith('.git')) raw = raw.slice(0, -4);
        repo = repo || raw;
      } catch {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
    }
    const rest = segments.slice(2).join('/').replace(/\/+$/, '');
    let svc = service;
    if (!svc) {
      if (rest === 'info/refs') svc = url.searchParams.get('service') ?? '';
      else if (rest === 'git-upload-pack') svc = 'git-upload-pack';
      else if (rest === 'git-receive-pack') svc = 'git-receive-pack';
    }
    const method = req.method ?? 'GET';
    const isInfoRefs = method === 'GET' && rest === 'info/refs';
    const isUploadPack = method === 'POST' && rest === 'git-upload-pack';
    const isReceivePack = method === 'POST' && rest === 'git-receive-pack';
    if (!isInfoRefs && !isUploadPack && !isReceivePack) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const repoObj = ownerName && repo ? store.getRepo(ownerName, repo) : undefined;
    if (!repoObj) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (isInfoRefs) {
      if (svc === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendBuffer(
          res,
          200,
          'application/x-git-upload-pack-advertisement',
          v2 ? v2Advertisement() : v0Advertisement(repoObj, 'git-upload-pack'),
        );
        return;
      }
      if (svc === 'git-receive-pack') {
        sendBuffer(
          res,
          200,
          'application/x-git-receive-pack-advertisement',
          v0Advertisement(repoObj, 'git-receive-pack'),
        );
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    const body = await readBody(req);
    if (isUploadPack) {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      try {
        const out = v2 ? handleUploadPackV2(repoObj, body) : handleUploadPackV0(repoObj, body);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
      } catch (err) {
        sendText(res, 400, `bad git-upload-pack request: ${(err as Error).message}`);
      }
      return;
    }

    // Receive-pack.
    try {
      const out = handleReceivePack(repoObj, store, body);
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
    } catch (err) {
      sendText(res, 400, `bad git-receive-pack request: ${(err as Error).message}`);
    }
  } catch (err) {
    if (!res.headersSent) {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing left to do.
      }
    }
    // Never let one request kill the server: log and keep serving.
    process.stderr.write(`[git] request failed: ${(err as Error).message}\n`);
  }
}
