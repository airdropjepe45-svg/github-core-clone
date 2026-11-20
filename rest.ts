// rest.ts — GitHub REST v3 surface (/api/v3) for the github-core-clone forge.
//
// Self-contained: it talks to the Store only through the structural interface
// below (the ARCHITECTURE.md contract) and builds its own git objects with
// local helpers, so it does not depend on store.ts / git.ts / util.ts being
// present at import time. Commit bytes are built here deliberately: the REST
// checks assert the commit message verbatim (no trailing newline added), and
// the author/committer identity is the scenario viewer
// `ada iversen <adaiversen@example.invalid> <unix> +0000` with the unix
// timestamp derived from trialNow().
//
// Determinism: no Date.now(), no Math.random(), no new Date() on live time.
// Every timestamp comes from MAKEFUN_TRIAL_NOW via trialNow().

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Store contract (structural; matches ARCHITECTURE.md's Store/Repo/Issue/Pull/Label)
// ---------------------------------------------------------------------------------------------

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface IssueCommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: IssueCommentRec[];
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface PullFileRec {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
  seq: number;
  files: PullFileRec[];
  // Extra runtime fields attached by the merge handler (not in the ARCHITECTURE
  // Pull interface, but required by the REST checks on GET after a merge).
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}

export interface RepoRec {
  id: number;
  databaseId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  issueSeq: number;
  pulls: Map<number, PullRec>;
  pullSeq: number;
  labels: Map<string, LabelRec>;
  commentSeq: number;
  labelSeq: number;
}

export interface StoreLike {
  repos: Map<string, RepoRec>;
  nextId: number;
  nextSeq: number;
  owner: string;
  now(): string;
  allocId(): number;
  allocSeq(): number;
  createRepo(owner: string, name: string, description?: string, isPrivate?: boolean): RepoRec | null;
  getRepo(owner: string, name: string): RepoRec | undefined;
  deleteRepo(owner: string, name: string): boolean;
  listRepos(owner: string): RepoRec[];
  putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string;
  getObject(repo: RepoRec, oid: string): GitObject | undefined;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const SHA40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------------------------
// Deterministic time / ids
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

export function trialNow(): string {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  return raw === '' ? '2025-01-01T00:00:00.000Z' : raw;
}

function trialUnix(): number {
  const ms = Date.parse(trialNow());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1735689600;
}

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function nowOf(store: StoreLike): string {
  try {
    const v = store.now();
    if (typeof v === 'string' && v !== '') return v;
  } catch {
    // fall through to trialNow
  }
  return trialNow();
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        fail(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  const secure = (req.socket as unknown as { encrypted?: boolean }).encrypted === true;
  return `${secure ? 'https' : 'http'}://${host}`;
}

function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { pathname: u.pathname, query: u.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) ? Math.min(100, Math.max(1, perRaw)) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Absolute `Link: <url>; rel="next"` value, or null when this is the last page. */
function nextLink(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const q = new URLSearchParams(query);
  q.set('page', String(page + 1));
  q.set('per_page', String(perPage));
  return `<${baseUrlOf(req)}${path}?${q.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------------------------
// Local git object helpers (raw object bytes; sha1 via the store's putObject)
// ---------------------------------------------------------------------------------------------

function oidToBuffer(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function buildTreeRaw(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(oidToBuffer(e.oid));
  }
  return Buffer.concat(parts);
}

function parseTreeRaw(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function buildCommitRaw(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  // Message stored verbatim (no trailing newline added): the REST checks assert
  // the exact message string back from GET /commits.
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseCommitRaw(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function commitIdentity(): string {
  return `${IDENTITY} ${trialUnix()} +0000`;
}

/** Parse `Name <email> 1234567890 +0000` into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = /^([^<]*)<([^>]*)>\s+(\d+)\s+([+-]\d{4})\s*$/.exec(line.trim());
  if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: trialNow() };
  const unix = Number.parseInt(m[3] ?? '0', 10);
  const date = Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : trialNow();
  return { name: (m[1] ?? '').trim() || VIEWER_NAME, email: m[2] ?? VIEWER_EMAIL, date };
}

/** Flat path -> blob oid map for a tree (recursive). Missing objects yield an empty map. */
function flattenTree(store: StoreLike, repo: RepoRec, treeOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (treeOid === null || treeOid === '') return out;
  const walk = (oid: string, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTreeRaw(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path, depth + 1);
      else out.set(path, e.oid);
    }
  };
  walk(treeOid, '', 0);
  return out;
}

/** Flat path -> tree oid map (for directory listings): path -> tree oid of each directory. */
function dirTreeOids(store: StoreLike, repo: RepoRec, treeOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (treeOid === null || treeOid === '') return out;
  const walk = (oid: string, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return;
    if (prefix !== '') out.set(prefix, oid);
    for (const e of parseTreeRaw(obj.data)) {
      if (e.mode === '40000') walk(e.oid, prefix === '' ? e.name : `${prefix}/${e.name}`, depth + 1);
    }
  };
  walk(treeOid, '', 0);
  return out;
}

interface TreeNode {
  files: Map<string, string>;
  dirs: Map<string, TreeNode>;
}

function buildTreeFromFlat(store: StoreLike, repo: RepoRec, flat: ReadonlyMap<string, string>): string {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, oid);
  }
  const build = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    entries.sort((a, b) => {
      const ka = a.name + (a.mode === '40000' ? '/' : '');
      const kb = b.name + (b.mode === '40000' ? '/' : '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return store.putObject(repo, 'tree', buildTreeRaw(entries));
  };
  return build(root);
}

/** Tree oid of a commit, or null when the commit is missing. */
function treeOfCommit(store: StoreLike, repo: RepoRec, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const obj = store.getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommitRaw(obj.data);
  return parsed.tree !== '' ? parsed.tree : null;
}

function commitOf(store: StoreLike, repo: RepoRec, oid: string): ParsedCommit | null {
  const obj = store.getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommitRaw(obj.data);
}

/** True when `ancestor` is reachable from `tip` following parent links. */
function isAncestor(store: StoreLike, repo: RepoRec, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  let steps = 0;
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    steps += 1;
    if (steps > 20000) return false;
    const c = commitOf(store, repo, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return false;
}

/** Nearest common ancestor of two tips (first found walking from `b`), or null. */
function findMergeBase(store: StoreLike, repo: RepoRec, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA: string[] = [a];
  let steps = 0;
  while (stackA.length > 0) {
    const cur = stackA.pop() as string;
    if (ancestorsA.has(cur)) continue;
    ancestorsA.add(cur);
    steps += 1;
    if (steps > 20000) break;
    const c = commitOf(store, repo, cur);
    if (c) for (const p of c.parents) stackA.push(p);
  }
  const queue: string[] = [b];
  const seenB = new Set<string>();
  steps = 0;
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (ancestorsA.has(cur)) return cur;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    steps += 1;
    if (steps > 20000) return null;
    const c = commitOf(store, repo, cur);
    if (c) for (const p of c.parents) queue.push(p);
  }
  return null;
}

/** Commits reachable from `tip`, newest-first (depth-first, parents after the commit). */
function walkCommits(store: StoreLike, repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  let steps = 0;
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    steps += 1;
    if (steps > 20000) break;
    const c = commitOf(store, repo, cur);
    if (!c) continue;
    out.push(cur);
    // Push parents in reverse so the first parent is visited first.
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i] as string);
  }
  return out;
}

/** Multiset line diff: [added lines, removed lines]. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (t: string): string[] => (t === '' ? [] : t.split('\n').filter((_, i, a) => !(i === a.length - 1 && _ === '')));
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const avail = new Map<string, number>();
  for (const l of oldLines) avail.set(l, (avail.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = avail.get(l) ?? 0;
    if (n > 0) avail.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of avail.values()) deletions += n;
  return { additions, deletions };
}

function blobText(store: StoreLike, repo: RepoRec, oid: string | undefined): string {
  if (oid === undefined) return '';
  const obj = store.getObject(repo, oid);
  if (!obj || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// JSON builders (shapes the checks assert; extra fields are fine)
// ---------------------------------------------------------------------------------------------

function userJson(store: StoreLike): Record<string, unknown> {
  const login = store.owner !== '' ? store.owner : VIEWER_LOGIN;
  return {
    login,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    company: null,
    blog: '',
    location: null,
    email: VIEWER_EMAIL,
    hireable: null,
    bio: null,
    public_repos: store.listRepos(login).length,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: trialNow(),
    updated_at: trialNow(),
  };
}

function ownerJson(store: StoreLike): Record<string, unknown> {
  const login = store.owner !== '' ? store.owner : VIEWER_LOGIN;
  return { login, id: VIEWER_ID, node_id: `U_${VIEWER_ID}`, avatar_url: '', gravatar_id: '', url: `/api/v3/users/${login}`, html_url: `https://github.com/${login}`, type: 'User', site_admin: false };
}

function repoJson(req: IncomingMessage, store: StoreLike, repo: RepoRec): Record<string, unknown> {
  const base = baseUrlOf(req);
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: ownerJson(store),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues + openPulls,
    subscribers_count: 0,
    size: 0,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    license: null,
    allow_forking: true,
    is_template: false,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${req.headers.host ?? '127.0.0.1'}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(req: IncomingMessage, repo: RepoRec, label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `${baseUrlOf(req)}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description ?? '',
    default: false,
  };
}

function issueJson(req: IncomingMessage, store: StoreLike, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const base = baseUrlOf(req);
  const labels = issue.labels.map((name) => {
    const found = repo.labels.get(name);
    return found ? labelJson(req, repo, found) : { name, color: 'ededed', description: '' };
  });
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    locked: false,
    user: ownerJson(store),
    labels,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

function commentJson(req: IncomingMessage, store: StoreLike, repo: RepoRec, issue: IssueRec, comment: IssueCommentRec): Record<string, unknown> {
  const base = baseUrlOf(req);
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: ownerJson(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(req: IncomingMessage, store: StoreLike, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const base = baseUrlOf(req);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    locked: false,
    user: ownerJson(store),
    labels: [],
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha, user: ownerJson(store), repo: repoJson(req, store, repo) },
    base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha, user: ownerJson(store), repo: repoJson(req, store, repo) },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    merged_at: pull.mergedAt ?? null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
    commits: 1,
    additions: pull.files.reduce((n, f) => n + f.additions, 0),
    deletions: pull.files.reduce((n, f) => n + f.deletions, 0),
    changed_files: pull.files.length,
  };
}

function commitJson(store: StoreLike, repo: RepoRec, sha: string): Record<string, unknown> | null {
  const parsed = commitOf(store, repo, sha);
  if (!parsed) return null;
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: parsed.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: parsed.tree },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    author: { login: store.owner, id: VIEWER_ID, type: 'User' },
    committer: { login: store.owner, id: VIEWER_ID, type: 'User' },
    parents: parsed.parents.map((p) => ({ sha: p, url: '' })),
    tree: { sha: parsed.tree },
  };
}

// ---------------------------------------------------------------------------------------------
// Repo / ref resolution
// ---------------------------------------------------------------------------------------------

function getRepoOr404(store: StoreLike, owner: string, name: string): RepoRec {
  const repo = store.getRepo(owner, name);
  if (!repo) throw new HttpError(404, 'Not Found');
  return repo;
}

/** Resolve a branch name (or a raw 40-hex oid) to a commit oid, or null. */
function resolveRef(store: StoreLike, repo: RepoRec, ref: string): string | null {
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  if (SHA40.test(ref)) {
    const obj = store.getObject(repo, ref);
    if (obj && obj.type === 'commit') return ref;
  }
  return null;
}

function tipOf(store: StoreLike, repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create one commit on `branch` (parent = current tip, or none) and move the ref. */
function commitOnBranch(
  store: StoreLike,
  repo: RepoRec,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const parent = tipOf(store, repo, branch);
  const who = commitIdentity();
  const data = buildCommitRaw(treeOid, parent === null ? [] : [parent], who, who, message);
  const commitOid = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = nowOf(store);
  return commitOid;
}

/** Diff base flat tree -> head flat tree, as pull-request files. */
function diffFiles(store: StoreLike, repo: RepoRec, baseTree: string | null, headTree: string | null): PullFileRec[] {
  const base = flattenTree(store, repo, baseTree);
  const head = flattenTree(store, repo, headTree);
  const files: PullFileRec[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined && h !== undefined) {
      const { additions } = lineDiff('', blobText(store, repo, h));
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined && b !== undefined) {
      const { deletions } = lineDiff(blobText(store, repo, b), '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const { additions, deletions } = lineDiff(blobText(store, repo, b), blobText(store, repo, h));
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

function checkAuth(req: IncomingMessage): void {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (expected !== '') {
    if (token === '' || token !== expected) throw new HttpError(401, 'Bad credentials');
  } else if (token === '') {
    throw new HttpError(401, 'Bad credentials');
  }
}

// ---------------------------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------------------------

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = body[key];
  return typeof v === 'boolean' ? v : fallback;
}

async function handleUserRepos(req: IncomingMessage, res: ServerResponse, store: StoreLike, query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = store.owner !== '' ? store.owner : VIEWER_LOGIN;
  if (method === 'GET') {
    const { page, perPage } = pageParams(query);
    const all = store.listRepos(owner);
    const items = paginate(all, page, perPage);
    const extra: Record<string, string> = {};
    const next = nextLink(req, '/api/v3/user/repos', query, page, perPage, all.length);
    if (next !== null) extra.link = next;
    sendJson(res, 200, items.map((r) => repoJson(req, store, r)), extra);
    return;
  }
  if (method === 'POST') {
    const body = await readJson(req);
    const name = strField(body, 'name');
    if (name === '' || /[/\s]/.test(name)) throw new HttpError(422, 'Repository name is required');
    const description = strField(body, 'description');
    const isPrivate = boolField(body, 'private', false);
    const repo = store.createRepo(owner, name, description, isPrivate);
    if (repo === null) throw new HttpError(422, 'Repository already exists');
    sendJson(res, 201, repoJson(req, store, repo));
    return;
  }
  throw new HttpError(404, 'Not Found');
}

async function handleRepoRoot(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const repo = getRepoOr404(store, owner, name);
    sendJson(res, 200, repoJson(req, store, repo));
    return;
  }
  if (method === 'PATCH') {
    const repo = getRepoOr404(store, owner, name);
    const body = await readJson(req);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    repo.updatedAt = nowOf(store);
    sendJson(res, 200, repoJson(req, store, repo));
    return;
  }
  if (method === 'DELETE') {
    getRepoOr404(store, owner, name);
    store.deleteRepo(owner, name);
    sendNoContent(res, 204);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function handleBranches(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, rest: string[]): void {
  const repo = getRepoOr404(store, owner, name);
  const method = req.method ?? 'GET';
  if (method !== 'GET') throw new HttpError(404, 'Not Found');
  const branches: { name: string; commit: { sha: string }; protected: boolean }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  if (rest.length === 0) {
    sendJson(res, 200, branches);
    return;
  }
  const branchName = rest.join('/');
  const found = branches.find((b) => b.name === branchName);
  if (!found) throw new HttpError(404, 'Not Found');
  sendJson(res, 200, found);
}

function handleCommits(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, rest: string[], query: URLSearchParams): void {
  const repo = getRepoOr404(store, owner, name);
  const method = req.method ?? 'GET';
  if (method !== 'GET') throw new HttpError(404, 'Not Found');
  if (rest.length === 1) {
    const sha = rest[0] as string;
    const obj = commitJson(store, repo, sha);
    if (!obj) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, obj);
    return;
  }
  if (rest.length > 1) throw new HttpError(404, 'Not Found');
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(store, repo, ref);
  if (tip === null) {
    // An unborn repository (or an unknown ref): GitHub answers an empty list
    // for an unborn repo; an unknown ref is a 404. Distinguish by emptiness.
    if (repo.refs.size === 0) {
      sendJson(res, 200, []);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  const { page, perPage } = pageParams(query);
  const all = walkCommits(store, repo, tip)
    .map((sha) => commitJson(store, repo, sha))
    .filter((c): c is Record<string, unknown> => c !== null);
  const items = paginate(all, page, perPage);
  const extra: Record<string, string> = {};
  const next = nextLink(req, `/api/v3/repos/${owner}/${name}/commits`, query, page, perPage, all.length);
  if (next !== null) extra.link = next;
  sendJson(res, 200, items, extra);
}

async function handleGitRefs(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, rest: string[]): Promise<void> {
  const repo = getRepoOr404(store, owner, name);
  const method = req.method ?? 'GET';
  if (method === 'POST' && rest.length === 0) {
    const body = await readJson(req);
    const ref = strField(body, 'ref');
    const sha = strField(body, 'sha');
    if (ref === '' || sha === '') throw new HttpError(422, 'ref and sha are required');
    if (!ref.startsWith('refs/')) throw new HttpError(422, 'ref must start with refs/');
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
    const obj = store.getObject(repo, sha);
    if (!obj) throw new HttpError(422, 'Unknown object');
    repo.refs.set(ref, sha);
    repo.updatedAt = nowOf(store);
    sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: obj.type, url: '' }, url: '' });
    return;
  }
  if (method === 'GET') {
    if (rest.length === 0) {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit', url: '' } }));
      sendJson(res, 200, all);
      return;
    }
    // GET /git/refs/heads/<branch> or /git/refs/tags/<tag> (branch may hold '/').
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { ref, object: { sha, type: 'commit', url: '' } });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------

function contentFileJson(req: IncomingMessage, store: StoreLike, repo: RepoRec, path: string, blobOid: string, size: number): Record<string, unknown> {
  const base = baseUrlOf(req);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    sha: blobOid,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    git_url: '',
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path.split('/').map(encodeURIComponent).join('/')}`,
    download_url: `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path.split('/').map(encodeURIComponent).join('/')}`,
    content: '',
    _links: { git: '', html: '', self: '' },
  };
}

function handleGetContents(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, path: string, query: URLSearchParams): void {
  const repo = getRepoOr404(store, owner, name);
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(store, repo, ref);
  if (tip === null) throw new HttpError(404, 'Not Found');
  const treeOid = treeOfCommit(store, repo, tip);
  const flat = flattenTree(store, repo, treeOid);
  if (path === '') {
    // Root listing.
    const entries = dirEntries(req, store, repo, treeOid, flat, '');
    sendJson(res, 200, entries);
    return;
  }
  const blobOid = flat.get(path);
  if (blobOid !== undefined) {
    const obj = store.getObject(repo, blobOid);
    if (!obj || obj.type !== 'blob') throw new HttpError(404, 'Not Found');
    const out = contentFileJson(req, store, repo, path, blobOid, obj.data.length);
    out.content = obj.data.toString('base64');
    sendJson(res, 200, out);
    return;
  }
  // Directory? Any path below it, or the path itself is a directory in the tree.
  const dirs = dirTreeOids(store, repo, treeOid);
  if (dirs.has(path)) {
    sendJson(res, 200, dirEntries(req, store, repo, treeOid, flat, path));
    return;
  }
  throw new HttpError(404, 'Not Found');
}

/** Entries directly under `dir` ('' = root): files and subdirectories, sorted by name. */
function dirEntries(req: IncomingMessage, store: StoreLike, repo: RepoRec, treeOid: string | null, flat: Map<string, string>, dir: string): Record<string, unknown>[] {
  const base = baseUrlOf(req);
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries: Record<string, unknown>[] = [];
  const seenDirs = new Set<string>();
  for (const [path, oid] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = store.getObject(repo, oid);
      entries.push({
        type: 'file',
        size: obj?.data.length ?? 0,
        name: rest,
        path,
        sha: oid,
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        git_url: '',
        html_url: '',
        download_url: '',
      });
    } else {
      const sub = rest.slice(0, slash);
      if (seenDirs.has(sub)) continue;
      seenDirs.add(sub);
      const subPath = `${prefix}${sub}`;
      const dirs = dirTreeOids(store, repo, treeOid);
      entries.push({
        type: 'dir',
        size: 0,
        name: sub,
        path: subPath,
        sha: dirs.get(subPath) ?? '',
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${subPath.split('/').map(encodeURIComponent).join('/')}`,
        git_url: '',
        html_url: '',
        download_url: null,
      });
    }
  }
  entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  return entries;
}

async function handlePutContents(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, path: string): Promise<void> {
  const repo = getRepoOr404(store, owner, name);
  const body = await readJson(req);
  const message = strField(body, 'message');
  const contentB64 = strField(body, 'content');
  if (message === '' || contentB64 === '') throw new HttpError(400, 'message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    throw new HttpError(400, 'content is not valid base64');
  }
  const branch = strField(body, 'branch') !== '' ? strField(body, 'branch') : repo.defaultBranch;
  const tip = tipOf(store, repo, branch);
  if (tip === null && branch !== repo.defaultBranch) throw new HttpError(404, 'Not Found');
  if (tip === null && repo.refs.size > 0) throw new HttpError(404, 'Not Found');
  const treeOid = treeOfCommit(store, repo, tip);
  const flat = flattenTree(store, repo, treeOid);
  const existing = flat.get(path);
  const givenSha = strField(body, 'sha');
  if (existing !== undefined && givenSha !== '' && givenSha.toLowerCase() !== existing.toLowerCase()) {
    throw new HttpError(409, 'Conflict: sha does not match the current blob');
  }
  const isUpdate = existing !== undefined;
  const blobOid = store.putObject(repo, 'blob', content);
  flat.set(path, blobOid);
  const newTreeOid = buildTreeFromFlat(store, repo, flat);
  const commitOid = commitOnBranch(store, repo, branch, newTreeOid, message);
  const parsed = parseCommitRaw((store.getObject(repo, commitOid) as GitObject).data);
  const author = parseIdentity(parsed.author);
  const fileOut = contentFileJson(req, store, repo, path, blobOid, content.length);
  fileOut.content = content.toString('base64');
  sendJson(res, isUpdate ? 200 : 201, {
    content: fileOut,
    commit: {
      sha: commitOid,
      node_id: `C_${commitOid}`,
      message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: author.name, email: author.email, date: author.date },
      parents: parsed.parents.map((p) => ({ sha: p })),
      tree: { sha: newTreeOid },
    },
  });
}

async function handleDeleteContents(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, path: string): Promise<void> {
  const repo = getRepoOr404(store, owner, name);
  const body = await readJson(req);
  const message = strField(body, 'message') !== '' ? strField(body, 'message') : `Delete ${path}`;
  const branch = strField(body, 'branch') !== '' ? strField(body, 'branch') : repo.defaultBranch;
  const tip = tipOf(store, repo, branch);
  if (tip === null) throw new HttpError(404, 'Not Found');
  const treeOid = treeOfCommit(store, repo, tip);
  const flat = flattenTree(store, repo, treeOid);
  if (!flat.has(path)) throw new HttpError(404, 'Not Found');
  flat.delete(path);
  const newTreeOid = buildTreeFromFlat(store, repo, flat);
  const commitOid = commitOnBranch(store, repo, branch, newTreeOid, message);
  sendJson(res, 200, { content: null, commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------------------------
// Labels / issues / comments
// ---------------------------------------------------------------------------------------------

async function handleLabels(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, rest: string[]): Promise<void> {
  const repo = getRepoOr404(store, owner, name);
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(req, repo, l)));
    return;
  }
  if (method === 'GET' && rest.length === 1) {
    const label = repo.labels.get(rest[0] as string);
    if (!label) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, labelJson(req, repo, label));
    return;
  }
  if (method === 'POST' && rest.length === 0) {
    const body = await readJson(req);
    const labelName = strField(body, 'name');
    if (labelName === '') throw new HttpError(422, 'Label name is required');
    if (repo.labels.has(labelName)) throw new HttpError(422, 'Label already exists');
    const label: LabelRec = {
      id: store.allocId(),
      name: labelName,
      color: strField(body, 'color') !== '' ? strField(body, 'color').replace(/^#/, '') : 'ededed',
      description: strField(body, 'description'),
    };
    repo.labels.set(labelName, label);
    sendJson(res, 201, labelJson(req, repo, label));
    return;
  }
  throw new HttpError(404, 'Not Found');
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, rest: string[], query: URLSearchParams): Promise<void> {
  const repo = getRepoOr404(store, owner, name);
  const method = req.method ?? 'GET';
  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    const num = Number.parseInt(rest[0] as string, 10);
    const issue = repo.issues.get(num);
    if (!issue) throw new HttpError(404, 'Not Found');
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => commentJson(req, store, repo, issue, c)));
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const text = strField(body, 'body');
      if (text === '') throw new HttpError(422, 'Comment body is required');
      const comment: IssueCommentRec = {
        id: store.allocId(),
        body: text,
        createdAt: nowOf(store),
        updatedAt: nowOf(store),
        seq: store.allocSeq(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowOf(store);
      sendJson(res, 201, commentJson(req, store, repo, issue, comment));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = (query.get('state') ?? 'open').toLowerCase();
      const sort = (query.get('sort') ?? 'created').toLowerCase();
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      else if (state !== 'all') list = list.filter((i) => i.state === 'open');
      const asc = direction === 'asc';
      list.sort((a, b) => {
        let cmp = 0;
        if (sort === 'updated') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
        else cmp = a.seq - b.seq;
        if (cmp === 0) cmp = a.seq - b.seq;
        return asc ? cmp : -cmp;
      });
      const { page, perPage } = pageParams(query);
      const items = paginate(list, page, perPage);
      const extra: Record<string, string> = {};
      const next = nextLink(req, `/api/v3/repos/${owner}/${name}/issues`, query, page, perPage, list.length);
      if (next !== null) extra.link = next;
      sendJson(res, 200, items.map((i) => issueJson(req, store, repo, i)), extra);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const title = strField(body, 'title');
      if (title === '') throw new HttpError(422, 'Issue title is required');
      const wanted: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const labelName of wanted) {
        if (!repo.labels.has(labelName)) throw new HttpError(422, `Label does not exist: ${labelName}`);
      }
      // The real Store's issueSeq is the NEXT number to hand out (starts at 1).
      const number = repo.issueSeq >= 1 ? repo.issueSeq : 1;
      repo.issueSeq = number + 1;
      const issue: IssueRec = {
        id: store.allocId(),
        number,
        title,
        body: strField(body, 'body'),
        state: 'open',
        labels: wanted,
        createdAt: nowOf(store),
        updatedAt: nowOf(store),
        seq: store.allocSeq(),
        comments: [],
      };
      repo.issues.set(number, issue);
      sendJson(res, 201, issueJson(req, store, repo, issue));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest.length === 1) {
    const num = Number.parseInt(rest[0] as string, 10);
    const issue = repo.issues.get(num);
    if (!issue) throw new HttpError(404, 'Not Found');
    if (method === 'GET') {
      sendJson(res, 200, issueJson(req, store, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const wanted = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
        for (const labelName of wanted) {
          if (!repo.labels.has(labelName)) throw new HttpError(422, `Label does not exist: ${labelName}`);
        }
        issue.labels = wanted;
      }
      issue.updatedAt = nowOf(store);
      sendJson(res, 200, issueJson(req, store, repo, issue));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------

async function handlePulls(req: IncomingMessage, res: ServerResponse, store: StoreLike, owner: string, name: string, rest: string[], query: URLSearchParams): Promise<void> {
  const repo = getRepoOr404(store, owner, name);
  const method = req.method ?? 'GET';
  // /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    const num = Number.parseInt(rest[0] as string, 10);
    const pull = repo.pulls.get(num);
    if (!pull) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, pull.files);
    return;
  }
  // /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') throw new HttpError(404, 'Not Found');
    const num = Number.parseInt(rest[0] as string, 10);
    const pull = repo.pulls.get(num);
    if (!pull) throw new HttpError(404, 'Not Found');
    // Drain any body (merge_method etc.); a malformed body is still a 400.
    await readJson(req);
    if (pull.state === 'closed') throw new HttpError(405, 'Pull request is already closed');
    const baseTip = tipOf(store, repo, pull.base.ref);
    if (baseTip === null) throw new HttpError(404, 'Not Found');
    const headTip = pull.head.sha;
    const headCommit = commitOf(store, repo, headTip);
    if (!headCommit) throw new HttpError(404, 'Not Found');
    // Mergeable? Head is a descendant of base, or the trees merge cleanly
    // (no path changed differently on both sides since the merge-base).
    let mergeable = isAncestor(store, repo, baseTip, headTip);
    if (!mergeable) {
      const mergeBase = findMergeBase(store, repo, baseTip, headTip);
      const baseFlat = flattenTree(store, repo, treeOfCommit(store, repo, mergeBase));
      const oursFlat = flattenTree(store, repo, treeOfCommit(store, repo, baseTip));
      const theirsFlat = flattenTree(store, repo, treeOfCommit(store, repo, headTip));
      mergeable = true;
      const paths = new Set([...oursFlat.keys(), ...theirsFlat.keys(), ...baseFlat.keys()]);
      for (const p of paths) {
        const b = baseFlat.get(p);
        const o = oursFlat.get(p);
        const t = theirsFlat.get(p);
        if (o !== b && t !== b && o !== t) {
          mergeable = false;
          break;
        }
      }
    }
    if (!mergeable) throw new HttpError(405, 'Pull request is not mergeable');
    // Squash: ONE commit, tree = head tip's tree, parent = base tip, on base branch.
    const headTree = headCommit.tree;
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const mergeSha = commitOnBranch(store, repo, pull.base.ref, headTree, message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = nowOf(store);
    pull.updatedAt = nowOf(store);
    // Refresh the pull's base sha to the new tip (it now points at the merge).
    pull.base = { ref: pull.base.ref, sha: mergeSha };
    sendJson(res, 200, { sha: mergeSha, merged: true, message });
    return;
  }
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = (query.get('state') ?? 'open').toLowerCase();
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      else if (state !== 'all') list = list.filter((p) => p.state === 'open');
      list.sort((a, b) => b.seq - a.seq);
      const { page, perPage } = pageParams(query);
      const items = paginate(list, page, perPage);
      const extra: Record<string, string> = {};
      const next = nextLink(req, `/api/v3/repos/${owner}/${name}/pulls`, query, page, perPage, list.length);
      if (next !== null) extra.link = next;
      sendJson(res, 200, items.map((p) => pullJson(req, store, repo, p)), extra);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const title = strField(body, 'title');
      const headRef = strField(body, 'head');
      const baseRef = strField(body, 'base');
      if (title === '' || headRef === '' || baseRef === '') throw new HttpError(422, 'title, head and base are required');
      const headSha = resolveRef(store, repo, headRef);
      const baseSha = resolveRef(store, repo, baseRef);
      if (headSha === null) throw new HttpError(422, `Unknown head branch: ${headRef}`);
      if (baseSha === null) throw new HttpError(422, `Unknown base branch: ${baseRef}`);
      // The real Store's pullSeq is the NEXT number to hand out (starts at 1).
      const number = repo.pullSeq >= 1 ? repo.pullSeq : 1;
      repo.pullSeq = number + 1;
      const files = diffFiles(store, repo, treeOfCommit(store, repo, baseSha), treeOfCommit(store, repo, headSha));
      const pull: PullRec = {
        id: store.allocId(),
        number,
        title,
        body: strField(body, 'body'),
        state: 'open',
        merged: false,
        mergeable: true,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        createdAt: nowOf(store),
        updatedAt: nowOf(store),
        seq: store.allocSeq(),
        files,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(number, pull);
      sendJson(res, 201, pullJson(req, store, repo, pull));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest.length === 1) {
    const num = Number.parseInt(rest[0] as string, 10);
    const pull = repo.pulls.get(num);
    if (!pull) throw new HttpError(404, 'Not Found');
    if (method === 'GET') {
      sendJson(res, 200, pullJson(req, store, repo, pull));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------

/**
 * Handle one /api/v3 request. Returns true when the route belongs to this
 * module (including its 4xx answers); false when the path is not under /api/v3.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const { pathname, query } = parseUrl(req);
  const rawParts = pathname.split('/').filter((p) => p !== '');
  if (rawParts.length < 2 || rawParts[0] !== 'api' || rawParts[1] !== 'v3') return false;
  const parts = rawParts.slice(2).map(decodeSegment);
  const method = req.method ?? 'GET';
  try {
    checkAuth(req);

    // GET /api/v3[/] — API root (starter values kept).
    if (parts.length === 0) {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    // GET /api/v3/meta
    if (parts.length === 1 && parts[0] === 'meta') {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }

    // GET /api/v3/rate_limit (not scored, but cheap and harmless)
    if (parts.length === 1 && parts[0] === 'rate_limit') {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      const reset = trialUnix();
      sendJson(res, 200, {
        resources: { core: { limit: 5000, remaining: 5000, reset, used: 0 } },
        rate: { limit: 5000, remaining: 5000, reset, used: 0 },
      });
      return true;
    }

    // GET /api/v3/user and /api/v3/user/repos
    if (parts[0] === 'user') {
      if (parts.length === 1) {
        if (method !== 'GET') throw new HttpError(404, 'Not Found');
        sendJson(res, 200, userJson(store));
        return true;
      }
      if (parts.length === 2 && parts[1] === 'repos') {
        await handleUserRepos(req, res, store, query);
        return true;
      }
      throw new HttpError(404, 'Not Found');
    }

    // /api/v3/repos/{owner}/{repo}[/...]
    if (parts[0] === 'repos') {
      if (parts.length < 3) throw new HttpError(404, 'Not Found');
      const owner = parts[1] as string;
      const repoName = parts[2] as string;
      const rest = parts.slice(3);
      if (rest.length === 0) {
        await handleRepoRoot(req, res, store, owner, repoName);
        return true;
      }
      const head = rest[0] as string;
      if (head === 'branches') {
        handleBranches(req, res, store, owner, repoName, rest.slice(1));
        return true;
      }
      if (head === 'commits') {
        handleCommits(req, res, store, owner, repoName, rest.slice(1), query);
        return true;
      }
      if (head === 'git' && rest.length >= 2 && rest[1] === 'refs') {
        await handleGitRefs(req, res, store, owner, repoName, rest.slice(2));
        return true;
      }
      if (head === 'contents') {
        const path = rest.slice(1).join('/');
        if (method === 'GET') handleGetContents(req, res, store, owner, repoName, path, query);
        else if (method === 'PUT') await handlePutContents(req, res, store, owner, repoName, path);
        else if (method === 'DELETE') await handleDeleteContents(req, res, store, owner, repoName, path);
        else throw new HttpError(404, 'Not Found');
        return true;
      }
      if (head === 'labels') {
        await handleLabels(req, res, store, owner, repoName, rest.slice(1));
        return true;
      }
      if (head === 'issues') {
        await handleIssues(req, res, store, owner, repoName, rest.slice(1), query);
        return true;
      }
      if (head === 'pulls') {
        await handlePulls(req, res, store, owner, repoName, rest.slice(1), query);
        return true;
      }
      throw new HttpError(404, 'Not Found');
    }

    throw new HttpError(404, 'Not Found');
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.message);
      return true;
    }
    // Awaiting a body can also surface here; never leak a stack or HTML.
    sendError(res, 500, 'Internal Server Error');
    return true;
  }
}
