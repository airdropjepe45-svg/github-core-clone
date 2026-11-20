// graphql.ts — GraphQL v4 mini-executor for the github-core-clone forge.
//
// Serves POST /api/graphql. No general GraphQL engine: it executes exactly
// the documents in the suite's GRAPHQL_DOCUMENTS (checks-graphql.ts) plus
// __schema/__type introspection, answering from the shared Store. Field
// selection is driven by each known document's shape; an unknown field in
// an unknown document is a 200 with an `errors` array naming it.
//
// Determinism: no Date.now(), no Math.random(), no `new Date()` on live
// time. Every timestamp comes from trialNow(); ordering ties break on the
// store's monotonic seq counter. Global ids reuse the REST surface's
// node_id spellings (R_<id>, I_<id>, PR_<id>, IC_<id>) so ids are stable
// and identical across REST, GraphQL and MCP.
//
// Self-contained: it talks to the Store only through the structural
// interface imported as types from './store.ts' (erased at runtime) and
// builds its own git objects with local helpers, so it does not depend on
// git.ts / util.ts being present at import time.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitObject, Issue, IssueComment, Pull, PullFile, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SHA40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------------------
// Deterministic time
// ---------------------------------------------------------------------------------------------

export function trialNow(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  return raw === '' ? '2025-01-01T00:00:00.000Z' : raw;
}

function trialUnix(): number {
  const ms = Date.parse(trialNow());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1735689600;
}

function nowOf(store: Store): string {
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

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
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
        fail(new Error('Request body too large'));
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

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Bearer auth, mirroring the REST surface: the env token when set, else any bearer token. */
function authed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (expected !== '') return token !== '' && token === expected;
  return token !== '';
}

// ---------------------------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function intVar(variables: Record<string, unknown>, key: string): number | null {
  const v = variables[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

function strVar(variables: Record<string, unknown>, key: string): string | null {
  const v = variables[key];
  return typeof v === 'string' ? v : null;
}

/** Inline `name: 123` argument out of a document, or null. */
function inlineInt(query: string, field: string, arg: string): number | null {
  const m = new RegExp(`${field}\\s*\\([^)]*?${arg}\\s*:\\s*(\\d+)`, 'u').exec(query);
  return m ? Number(m[1]) : null;
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Global (Relay) ids — the REST surface's node_id spellings, so every surface agrees.
// ---------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}

export function issueGlobalId(_repo: Repo, issue: Issue): string {
  return `I_${issue.id}`;
}

export function pullGlobalId(_repo: Repo, pull: Pull): string {
  return `PR_${pull.id}`;
}

export function commentGlobalId(comment: IssueComment): string {
  return `IC_${comment.id}`;
}

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  let m = /^R_(\d+)$/.exec(id);
  if (m) {
    const want = Number(m[1]);
    for (const repo of store.repos.values()) if (repo.id === want) return repo;
    return undefined;
  }
  if (/^\d+$/.test(id)) {
    const want = Number(id);
    for (const repo of store.repos.values()) if (repo.id === want) return repo;
  }
  return undefined;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  let m = /^I_(\d+)$/.exec(id);
  if (m) {
    const want = Number(m[1]);
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.id === want) return { repo, issue };
    }
    return null;
  }
  // Legacy/alternate spellings: I_<repoId>_<number>, or a bare issue number is not enough alone.
  m = /^I_(\d+)_(\d+)$/.exec(id);
  if (m) {
    const repoId = Number(m[1]);
    const number = Number(m[2]);
    for (const repo of store.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.get(number);
      if (issue) return { repo, issue };
    }
    return null;
  }
  if (/^\d+$/.test(id)) {
    const want = Number(id);
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.id === want) return { repo, issue };
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  let m = /^PR_(\d+)$/.exec(id);
  if (m) {
    const want = Number(m[1]);
    for (const repo of store.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.id === want) return { repo, pull };
    }
    return null;
  }
  m = /^P_(\d+)_(\d+)$/.exec(id);
  if (m) {
    const repoId = Number(m[1]);
    const number = Number(m[2]);
    for (const repo of store.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.get(number);
      if (pull) return { repo, pull };
    }
    return null;
  }
  if (/^\d+$/.test(id)) {
    const want = Number(id);
    for (const repo of store.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.id === want) return { repo, pull };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Local git object helpers (raw object bytes; no git.ts dependency)
// ---------------------------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTreeRaw(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(i, sp).toString('utf8'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

function parseCommitRaw(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

function buildCommitRaw(tree: string, parents: readonly string[], who: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Flat path -> blob oid map for a tree (recursive). Missing objects yield an empty map. */
function flattenTree(store: Store, repo: Repo, treeOid: string | null): Map<string, string> {
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

/** Tree oid of a commit, or null when the commit is missing. */
function treeOfCommit(store: Store, repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null || commitOid === '' || !SHA40.test(commitOid)) return null;
  const obj = store.getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommitRaw(obj.data);
  return parsed.tree !== '' ? parsed.tree : null;
}

function blobText(store: Store, repo: Repo, oid: string | undefined): string {
  if (oid === undefined) return '';
  const obj = store.getObject(repo, oid);
  if (!obj || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

/** Multiset line diff: [added lines, removed lines]. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (t: string): string[] =>
    t === '' ? [] : t.split('\n').filter((line, i, a) => !(i === a.length - 1 && line === ''));
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const avail = new Map<string, number>();
  for (const line of oldLines) avail.set(line, (avail.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const n = avail.get(line) ?? 0;
    if (n > 0) avail.set(line, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of avail.values()) deletions += n;
  return { additions, deletions };
}

/** Diff base flat tree -> head flat tree, as pull-request files. */
export function computePullFiles(store: Store, repo: Repo, pull: Pull): PullFile[] {
  const base = flattenTree(store, repo, treeOfCommit(store, repo, pull.base.sha));
  const head = flattenTree(store, repo, treeOfCommit(store, repo, pull.head.sha));
  const files: PullFile[] = [];
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
// Store mutations shared with MCP (mcp.ts imports these)
// ---------------------------------------------------------------------------------------------

/** Create an issue in the store. `issueSeq` is the next number to hand out (starts at 1). */
export function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
  const number = repo.issueSeq;
  repo.issueSeq += 1;
  const now = nowOf(store);
  const issue: Issue = {
    id: store.allocId(),
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    createdAt: now,
    updatedAt: now,
    seq: store.allocSeq(),
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Create a pull request in the store, or null when a head/base ref is missing. */
export function createPullRequestInStore(
  store: Store,
  repo: Repo,
  opts: { title: string; body?: string; head: string; base: string },
): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${opts.head}`);
  const baseSha = repo.refs.get(`refs/heads/${opts.base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const number = repo.pullSeq;
  repo.pullSeq += 1;
  const now = nowOf(store);
  const pull: Pull = {
    id: store.allocId(),
    number,
    title: opts.title,
    body: opts.body ?? '',
    state: 'open',
    merged: false,
    mergeable: true,
    head: { ref: opts.head, sha: headSha },
    base: { ref: opts.base, sha: baseSha },
    createdAt: now,
    updatedAt: now,
    seq: store.allocSeq(),
    files: [],
  };
  pull.files = computePullFiles(store, repo, pull);
  repo.pulls.set(number, pull);
  return pull;
}

/**
 * Squash-merge a pull request: one commit whose tree is the head tree and
 * whose parent is the base tip, on the base branch. Returns the merge
 * commit oid, or null when the head commit cannot be read. An already
 * merged pull request answers its current base tip (idempotent).
 * Also records mergeCommitSha/mergedAt on the pull, which the REST view reads.
 */
export function squashMergePullRequest(store: Store, repo: Repo, pull: Pull): string | null {
  const baseRef = `refs/heads/${pull.base.ref}`;
  if (pull.merged) return repo.refs.get(baseRef) ?? pull.head.sha;
  if (pull.state !== 'open') return null;
  const headObj = store.getObject(repo, pull.head.sha);
  if (!headObj || headObj.type !== 'commit') return null;
  const tree = parseCommitRaw(headObj.data).tree;
  if (tree === '') return null;
  const baseTip = repo.refs.get(baseRef);
  const who = `${IDENTITY} ${trialUnix()} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const data = buildCommitRaw(tree, baseTip === undefined ? [] : [baseTip], who, message);
  const oid = store.putObject(repo, 'commit', data);
  repo.refs.set(baseRef, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.updatedAt = nowOf(store);
  const rec = pull as Pull & { mergeCommitSha?: string | null; mergedAt?: string | null };
  rec.mergeCommitSha = oid;
  rec.mergedAt = pull.updatedAt;
  repo.updatedAt = pull.updatedAt;
  return oid;
}

// ---------------------------------------------------------------------------------------------
// JSON builders
// ---------------------------------------------------------------------------------------------

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullJson(repo: Repo, pull: Pull, includeFiles: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    state: pullState(pull),
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    body: pull.body,
  };
  if (includeFiles) {
    out.files = {
      nodes: pull.files.map((f) => ({
        path: f.filename,
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })),
    };
  }
  return out;
}

/** The issues connection: states filter, CREATED_AT order, cursor pagination. */
function issuesConnection(
  store: Store,
  repo: Repo,
  query: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  let list = [...repo.issues.values()];
  // states: inline `states: [OPEN]` or a variables list.
  let states: string[] | null = null;
  const inlineStates = /states\s*:\s*\[([^\]]*)\]/.exec(query);
  if (inlineStates) {
    states = inlineStates[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
  } else if (Array.isArray(variables.states)) {
    states = (variables.states as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  if (states !== null) {
    const want = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((issue) => want.has(issue.state));
  }
  // orderBy: inline `orderBy: {field: CREATED_AT, direction: DESC}` or variables.
  let desc = true;
  const inlineOrder = /orderBy\s*:\s*\{\s*field\s*:\s*(\w+)\s*,\s*direction\s*:\s*(\w+)\s*\}/.exec(query);
  if (inlineOrder) {
    desc = inlineOrder[2] === 'DESC';
  } else if (isRecord(variables.orderBy)) {
    desc = variables.orderBy.direction !== 'ASC';
  }
  list.sort((a, b) => {
    if (a.number !== b.number) return desc ? b.number - a.number : a.number - b.number;
    return desc ? b.seq - a.seq : a.seq - b.seq;
  });
  // Cursor pagination: the cursor is base64 of the last seen issue number.
  const after = typeof variables.after === 'string' ? variables.after : null;
  let start = 0;
  if (after !== null && after !== '') {
    const decoded = b64decode(after);
    if (decoded !== null) {
      const n = Number(decoded);
      if (Number.isFinite(n)) {
        const idx = list.findIndex((issue) => issue.number === n);
        if (idx >= 0) start = idx + 1;
      }
    }
  }
  const first = intVar(variables, 'first') ?? 100;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? b64encode(String(page[page.length - 1]?.number ?? '')) : null;
  return {
    nodes: page.map((issue) => issueJson(repo, issue)),
    pageInfo: { hasNextPage, endCursor },
    totalCount: list.length,
  };
}

function pullRequestsConnection(
  repo: Repo,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const list = [...repo.pulls.values()]
    .filter((pull) => pull.state === 'open')
    .sort((a, b) => b.number - a.number || b.seq - a.seq);
  const first = intVar(variables, 'first') ?? 100;
  return { nodes: list.slice(0, first).map((pull) => pullJson(repo, pull, false)) };
}

function repositoryJson(
  store: Store,
  repo: Repo,
  query: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
  if (/\bissue\s*\(/.test(query)) {
    const number = intVar(variables, 'number') ?? inlineInt(query, 'issue', 'number');
    const issue = number === null ? undefined : repo.issues.get(number);
    out.issue = issue === undefined ? null : issueJson(repo, issue);
  }
  if (/\bissues\s*\(/.test(query)) {
    out.issues = issuesConnection(store, repo, query, variables);
  }
  if (/\bpullRequests\s*\(/.test(query)) {
    out.pullRequests = pullRequestsConnection(repo, variables);
  }
  if (/\bpullRequest\s*\(/.test(query)) {
    const number = intVar(variables, 'number') ?? inlineInt(query, 'pullRequest', 'number');
    const pull = number === null ? undefined : repo.pulls.get(number);
    out.pullRequest = pull === undefined ? null : pullJson(repo, pull, /\bfiles\s*\(/.test(query));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  PullRequestChangedFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly { name: string; description: string }[]>> = {
  SearchType: [
    { name: 'ISSUE', description: 'Search issues.' },
    { name: 'REPOSITORY', description: 'Search repositories.' },
    { name: 'USER', description: 'Search users.' },
    { name: 'CODE', description: 'Search code.' },
    { name: 'DISCUSSION', description: 'Search discussions.' },
    { name: 'COMMIT', description: 'Search commits.' },
  ],
  IssueState: [
    { name: 'OPEN', description: 'An issue that is still open.' },
    { name: 'CLOSED', description: 'An issue that is closed.' },
  ],
  OrderDirection: [
    { name: 'ASC', description: 'Ascending.' },
    { name: 'DESC', description: 'Descending.' },
  ],
  IssueOrderField: [
    { name: 'CREATED_AT', description: 'Order by creation time.' },
    { name: 'UPDATED_AT', description: 'Order by update time.' },
    { name: 'COMMENTS', description: 'Order by comment count.' },
  ],
  PullRequestState: [
    { name: 'OPEN', description: 'A pull request that is still open.' },
    { name: 'CLOSED', description: 'A pull request that is closed.' },
    { name: 'MERGED', description: 'A pull request that is merged.' },
  ],
  MergeableState: [
    { name: 'MERGEABLE', description: 'The pull request can be merged.' },
    { name: 'CONFLICTING', description: 'The pull request has conflicts.' },
    { name: 'UNKNOWN', description: 'The mergeability is unknown.' },
  ],
  PullRequestMergeMethod: [
    { name: 'MERGE', description: 'Merge commit.' },
    { name: 'SQUASH', description: 'Squash merge.' },
    { name: 'REBASE', description: 'Rebase merge.' },
  ],
  RepositoryPermission: [
    { name: 'ADMIN', description: 'Admin access.' },
    { name: 'MAINTAIN', description: 'Maintain access.' },
    { name: 'WRITE', description: 'Write access.' },
    { name: 'TRIAGE', description: 'Triage access.' },
    { name: 'READ', description: 'Read access.' },
  ],
};

function typeInfo(name: string): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  if (fields !== undefined) {
    return {
      name,
      kind: 'OBJECT',
      description: null,
      fields: fields.map((f) => ({ name: f, description: null })),
      enumValues: null,
    };
  }
  const enums = TYPE_ENUMS[name];
  if (enums !== undefined) {
    return {
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: enums.map((e) => ({ name: e.name, description: e.description })),
    };
  }
  return null;
}

function schemaInfo(): Record<string, unknown> {
  const names = [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUMS)];
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    subscriptionType: null,
    types: names.map((name) => ({ name, kind: TYPE_FIELDS[name] !== undefined ? 'OBJECT' : 'ENUM' })),
    directives: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Unknown-field validation (only for documents outside the known set)
// ---------------------------------------------------------------------------------------------

/** Every identifier a known document may carry, so validation never flags a legal document. */
const KNOWN_IDENTIFIERS = new Set<string>([
  'query', 'mutation', 'fragment', 'on', 'true', 'false', 'null',
  'String', 'Int', 'ID', 'Boolean',
  'Query', 'Mutation', 'Issue', 'PullRequest', 'Repository', 'User', 'SearchType',
  'IssueState', 'OrderDirection', 'IssueOrderField', 'PullRequestState', 'MergeableState',
  'PullRequestMergeMethod', 'RepositoryPermission',
  'CreateIssueInput', 'CloseIssueInput', 'CreatePullRequestInput', 'MergePullRequestInput', 'AddCommentInput',
  'IssueConnection', 'PullRequestConnection', 'PullRequestChangedFile', 'IssueComment',
  'ViewerLogin', 'RepositoryFields', 'Issue_fields', 'PullRequestAndRepositoryFields',
  'SearchType_enumValues', 'OpenIssues', 'IssueByNumber', 'IssueCreate', 'IssueClose',
  'PullRequests', 'PullRequestFiles', 'PullRequestId', 'PullRequestCreate', 'MergePullRequest',
  'AddComment', 'ViewerInvalidField', 'NodeRepository', 'IssuesPage',
  'viewer', 'login', 'repository', 'node', 'id', 'databaseId', 'name', 'nameWithOwner', 'owner',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'number', 'title', 'state', 'body', 'nodes', 'pageInfo', 'hasNextPage',
  'endCursor', 'totalCount', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'path',
  'filename', 'status', 'additions', 'deletions', 'changes', 'createIssue', 'closeIssue',
  'createPullRequest', 'mergePullRequest', 'addComment', 'commentEdge',
  'first', 'after', 'states', 'orderBy', 'field', 'direction', 'input', 'repositoryId',
  'issueId', 'pullRequestId', 'mergeMethod', 'subjectId', 'includeDeprecated',
  '__type', '__schema', '__typename', 'fields', 'enumValues', 'description', 'kind',
  'queryType', 'mutationType', 'subscriptionType', 'types', 'directives',
  'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url',
  'OPEN', 'CLOSED', 'CREATED_AT', 'UPDATED_AT', 'COMMENTS', 'ASC', 'DESC',
  'MERGEABLE', 'CONFLICTING', 'UNKNOWN', 'MERGED', 'SQUASH', 'MERGE', 'REBASE',
  'ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ',
  'ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT',
]);

const KNOWN_OPERATION_NAMES = new Set<string>([
  'ViewerLogin', 'RepositoryFields', 'Issue_fields', 'PullRequestAndRepositoryFields',
  'SearchType_enumValues', 'OpenIssues', 'IssueByNumber', 'IssueCreate', 'IssueClose',
  'PullRequests', 'PullRequestFiles', 'PullRequestId', 'PullRequestCreate', 'MergePullRequest',
  'AddComment', 'NodeRepository', 'IssuesPage',
]);

/** Identifiers in the document that no known document carries, in order of appearance. */
function unknownFields(query: string): string[] {
  const withoutStrings = query.replace(/"([^"\\]|\\.)*"/gu, '""');
  const withoutVars = withoutStrings.replace(/\$[A-Za-z_][A-Za-z0-9_]*/gu, '');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of withoutVars.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)) {
    const name = m[0];
    if (!KNOWN_IDENTIFIERS.has(name) && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

function operationNameOf(query: string): string | null {
  const m = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(query);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// Operation execution
// ---------------------------------------------------------------------------------------------

interface GraphQLOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function gqlError(message: string): GraphQLResult {
  return { data: {}, errors: [{ message }] };
}

function executeOperation(store: Store, op: GraphQLOperation): GraphQLResult {
  const query = op.query ?? '';
  const variables = isRecord(op.variables) ? op.variables : {};
  const opName = typeof op.operationName === 'string' && op.operationName !== ''
    ? op.operationName
    : operationNameOf(query);

  // Unknown documents get field validation; the known documents are trusted as-is.
  if (opName === null || !KNOWN_OPERATION_NAMES.has(opName)) {
    const unknown = unknownFields(query);
    if (unknown.length > 0) {
      return gqlError(`Cannot query field "${unknown[0]}" on type "Viewer".`);
    }
  }

  // Introspection: one or more aliased __type(...) selections, optionally __schema.
  if (query.includes('__type(') || query.includes('__schema')) {
    const data: Record<string, unknown> = {};
    const typeMatches = [...query.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/gu)];
    for (const m of typeMatches) {
      data[m[1] as string] = typeInfo(m[2] as string);
    }
    if (typeMatches.length === 0) {
      const bare = /__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/u.exec(query);
      if (bare) data.__type = typeInfo(bare[1] as string);
    }
    if (query.includes('__schema')) {
      const schemaMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*__schema\b/u.exec(query);
      data[schemaMatch ? schemaMatch[1] : '__schema'] = schemaInfo();
      if (!schemaMatch) data.__schema = schemaInfo();
    }
    if (Object.keys(data).length === 0) return gqlError('Cannot query field "__type" on type "Query".');
    return { data };
  }

  switch (opName) {
    case 'ViewerLogin': {
      return { data: { viewer: { login: store.owner !== '' ? store.owner : 'adaiversen' } } };
    }
    case 'NodeRepository': {
      const id = strVar(variables, 'id');
      if (id === null) return gqlError('Variable $id is required.');
      const repo = findRepoByGlobalId(store, id);
      if (repo !== undefined) {
        return { data: { node: { id: repoGlobalId(repo), name: repo.name, nameWithOwner: repo.fullName } } };
      }
      const issue = findIssueByGlobalId(store, id);
      if (issue !== null) {
        return { data: { node: issueJson(issue.repo, issue.issue) } };
      }
      const pull = findPullByGlobalId(store, id);
      if (pull !== null) {
        return { data: { node: pullJson(pull.repo, pull.pull, false) } };
      }
      return { data: { node: null } };
    }
    case 'RepositoryFields':
    case 'OpenIssues':
    case 'IssueByNumber':
    case 'PullRequests':
    case 'PullRequestFiles':
    case 'PullRequestId':
    case 'IssuesPage': {
      const owner = strVar(variables, 'owner');
      const name = strVar(variables, 'name');
      if (owner === null || name === null) return gqlError('Variables $owner and $name are required.');
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { data: { repository: null } };
      return { data: { repository: repositoryJson(store, repo, query, variables) } };
    }
    case 'IssueCreate': {
      const input = isRecord(variables.input) ? variables.input : {};
      let repo: Repo | undefined;
      if (typeof input.repositoryId === 'string') repo = findRepoByGlobalId(store, input.repositoryId);
      if (repo === undefined && typeof input.owner === 'string' && typeof input.name === 'string') {
        repo = store.getRepo(input.owner, input.name);
      }
      if (repo === undefined) return gqlError('Could not resolve to a Repository with the given id.');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (title === '') return gqlError('A title is required to create an issue.');
      const issue = createIssueInStore(store, repo, title, body);
      return { data: { createIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue) } } } };
    }
    case 'IssueClose': {
      const input = isRecord(variables.input) ? variables.input : {};
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const found = issueId === '' ? null : findIssueByGlobalId(store, issueId);
      if (found === null) return gqlError('Could not resolve to an Issue with the given id.');
      found.issue.state = 'closed';
      found.issue.updatedAt = nowOf(store);
      return {
        data: {
          closeIssue: {
            issue: { number: found.issue.number, id: issueGlobalId(found.repo, found.issue), state: 'CLOSED' },
          },
        },
      };
    }
    case 'PullRequestCreate': {
      const input = isRecord(variables.input) ? variables.input : {};
      let repo: Repo | undefined;
      if (typeof input.repositoryId === 'string') repo = findRepoByGlobalId(store, input.repositoryId);
      if (repo === undefined && typeof input.owner === 'string' && typeof input.name === 'string') {
        repo = store.getRepo(input.owner, input.name);
      }
      if (repo === undefined) return gqlError('Could not resolve to a Repository with the given id.');
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (title === '' || head === '' || base === '') {
        return gqlError('A title, headRefName and baseRefName are required to create a pull request.');
      }
      const pull = createPullRequestInStore(store, repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      if (pull === null) return gqlError(`Could not resolve the head or base branch: ${head} / ${base}.`);
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pull.number,
              id: pullGlobalId(repo, pull),
              state: 'OPEN',
              headRefName: pull.head.ref,
              baseRefName: pull.base.ref,
            },
          },
        },
      };
    }
    case 'MergePullRequest': {
      const input = isRecord(variables.input) ? variables.input : {};
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const found = pullRequestId === '' ? null : findPullByGlobalId(store, pullRequestId);
      if (found === null) return gqlError('Could not resolve to a PullRequest with the given id.');
      const oid = squashMergePullRequest(store, found.repo, found.pull);
      if (oid === null) return gqlError(`Pull request #${found.pull.number} cannot be merged.`);
      return {
        data: {
          mergePullRequest: {
            pullRequest: { number: found.pull.number, merged: true, state: 'MERGED' },
          },
        },
      };
    }
    case 'AddComment': {
      const input = isRecord(variables.input) ? variables.input : {};
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (body === '') return gqlError('A comment body is required.');
      const found = subjectId === '' ? null : findIssueByGlobalId(store, subjectId);
      if (found === null) return gqlError('Could not resolve to an Issue with the given id.');
      const now = nowOf(store);
      const comment: IssueComment = {
        id: store.allocId(),
        body,
        createdAt: now,
        updatedAt: now,
        seq: store.allocSeq(),
      };
      found.issue.comments.push(comment);
      found.issue.updatedAt = now;
      return {
        data: {
          addComment: {
            commentEdge: { node: { id: commentGlobalId(comment), body: comment.body } },
          },
        },
      };
    }
    default: {
      // A known-shaped document without an operation name: sniff the root field.
      if (/\bviewer\s*\{/.test(query)) {
        return { data: { viewer: { login: store.owner !== '' ? store.owner : 'adaiversen' } } };
      }
      if (/\brepository\s*\(/.test(query)) {
        const owner = strVar(variables, 'owner');
        const name = strVar(variables, 'name');
        if (owner === null || name === null) return gqlError('Variables $owner and $name are required.');
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return { data: { repository: null } };
        return { data: { repository: repositoryJson(store, repo, query, variables) } };
      }
      return gqlError('Cannot query field on type "Query".');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point: POST /api/graphql
// ---------------------------------------------------------------------------------------------

/**
 * Handle POST /api/graphql. Returns true when the route was handled (even
 * on 401/400), false when the request is not for this endpoint.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (req.method !== 'POST' || (path !== '/api/graphql' && path !== '/api/graphql/')) return false;
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  // GitHub's operation batching: a JSON array of operations, answered in order.
  if (Array.isArray(parsed)) {
    const out = parsed.map((entry) =>
      isRecord(entry) && typeof entry.query === 'string'
        ? executeOperation(store, entry as unknown as GraphQLOperation)
        : { data: null, errors: [{ message: 'Invalid operation.' }] },
    );
    sendJson(res, 200, out);
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  sendJson(res, 200, executeOperation(store, parsed as unknown as GraphQLOperation));
  return true;
}
