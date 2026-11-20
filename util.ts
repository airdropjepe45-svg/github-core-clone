// util.ts — small shared helpers for the forge: hashing, git pkt-lines,
// base64, the trial clock, JSON bodies and JSON replies.
//
// Determinism rule: no Date.now(), no Math.random(), no `new Date()` in
// anything stored or sent. All timestamps come from trialNow().

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SCENARIO_SEED_HEX } from './scenario.ts';

/** Largest request body the forge will read: 10 MiB. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Fallback trial timestamp when MAKEFUN_TRIAL_NOW is unset. */
export const FALLBACK_TRIAL_NOW = '2025-01-01T00:00:00.000Z';

/** sha1 hex (40 lowercase hex chars) of `data`. */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * One pkt-line: a 4-hex-digit length prefix (the total length, header
 * included) followed by the payload bytes.
 */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 0xffff) throw new Error(`pkt-line payload too large: ${body.length} bytes`);
  const header = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** A flush pkt-line: the four bytes `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/**
 * Parse a buffer of pkt-lines into an array: one entry per line, `null`
 * for each flush packet. Text payloads come back as strings (newlines
 * preserved); a payload that is not valid UTF-8 comes back as a Buffer.
 * A trailing incomplete line is ignored; callers that need strictness
 * check `buf.length` against the bytes consumed.
 */
export function parsePktLines(buf: Buffer): (string | Buffer | null)[] {
  const out: (string | Buffer | null)[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenText, 16);
    if (!Number.isSafeInteger(len) || len < 0 || len > 0xffff) break;
    if (len === 0) {
      out.push(null);
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    const payload = buf.subarray(offset + 4, offset + len);
    try {
      out.push(decoder.decode(payload));
    } catch {
      out.push(Buffer.from(payload));
    }
    offset += len;
  }
  return out;
}

/** Standard base64 (with padding) of `data`. */
export function b64encode(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
}

/** Decode standard base64 to bytes. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text, 'base64');
}

/**
 * The trial clock: MAKEFUN_TRIAL_NOW when set, else the fixed fallback.
 * Every timestamp the forge stores or sends comes from here.
 */
export function trialNow(): string {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  return raw === '' ? FALLBACK_TRIAL_NOW : raw;
}

/** The trial seed: MAKEFUN_TRIAL_SEED when set, else the scenario seed hex. */
export function trialSeed(): string {
  const raw = (process.env.MAKEFUN_TRIAL_SEED ?? '').trim();
  return raw === '' ? SCENARIO_SEED_HEX : raw;
}

let requestCounter = 0;

/**
 * A per-request id, `req-<n>`, from a process-wide counter starting at 1.
 * Deterministic: it depends only on how many requests this process has
 * answered, never on a clock or random source.
 */
export function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/**
 * Answer with a JSON body. Always sets `Content-Type: application/json`,
 * a `Content-Length`, and a non-empty `X-GitHub-Request-Id` (unless the
 * caller supplied one in `headers`). The body is JSON plus a newline.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  const merged: Record<string, string> = { ...headers };
  const hasRequestId = Object.keys(merged).some((key) => key.toLowerCase() === 'x-github-request-id');
  if (!hasRequestId) merged['x-github-request-id'] = requestId();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...merged,
  });
  res.end(text);
}

/** An error carrying the HTTP status a body problem should be answered with. */
export class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Read the whole request body as bytes, up to `maxBytes` (default
 * MAX_BODY_BYTES). Throws a BodyError(413) past the cap and a
 * BodyError(400) when the stream itself errors.
 */
export function readBodyBuffer(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        req.resume();
        reject(new BodyError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(new BodyError(400, err instanceof Error ? err.message : 'Request body could not be read'));
      }
    });
  });
}

/**
 * Read and parse a JSON request body. An empty body parses as `null`.
 * Throws a BodyError(400) on malformed JSON and a BodyError(413) past
 * the 10 MiB cap; app.ts turns those into the matching JSON error reply,
 * so handlers may let the throw propagate.
 */
export async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBodyBuffer(req);
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new BodyError(400, 'Malformed JSON in request body');
  }
}
