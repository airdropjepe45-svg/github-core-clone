// mcp.ts — Model Context Protocol endpoint for the github-core-clone forge.
//
// Serves POST /mcp: JSON-RPC 2.0 over Streamable HTTP (plain JSON bodies).
// Speaks both protocol eras the suite accepts: the modern 2026-07-28
// `server/discover` flow and the legacy handshake (`initialize` +
// `notifications/initialized`, revisions back to 2024-11-05). Tools act on
// the SAME Store as REST and GraphQL, so ids are identical across surfaces.
//
// Determinism: no Date.now(), no Math.random(), no `new Date()` on live
// time. Every timestamp comes from trialNow(). The tools list is built
// once at module load and reused, so two tools/list calls answer
// byte-identical tools arrays.
//
// Self-contained: store mutations and git helpers are imported from
// './graphql.ts' (this worker's own file); the Store is only touched
// through the structural interface imported as types from './store.ts'.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import {
  createIssueInStore,
  createPullRequestInStore,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  squashMergePullRequest,
  trialNow,
} from './graphql.ts';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

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

function nowOf(store: Store): string {
  try {
    const v = store.now();
    if (typeof v === 'string' && v !== '') return v;
  } catch {
    // fall through
  }
  return trialNow();
}

/** First non-empty value among the given argument spellings. */
function pick(args: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const v = args[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const v = pick(args, keys);
  return typeof v === 'string' ? v : undefined;
}

function pickInt(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const v = pick(args, keys);
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function pickBool(args: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  const v = pick(args, keys);
  return typeof v === 'boolean' ? v : undefined;
}

/** Resolve owner/repo from the documented names, near-name variants, or a full_name. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((owner === undefined || repo === undefined)) {
    const full = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
    if (full !== undefined && full.includes('/')) {
      const [o, r] = full.split('/', 2);
      if (owner === undefined && o !== '') owner = o;
      if (repo === undefined && r !== '') repo = r;
    }
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------------------------
// JSON builders (REST-like shapes, so cross-surface reads agree)
// ---------------------------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const rec = pull as Pull & { mergeCommitSha?: string | null; mergedAt?: string | null };
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: rec.mergeCommitSha ?? null,
    merged_at: rec.mergedAt ?? null,
    head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha },
    base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    files: pull.files,
  };
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

/**
 * The tools list, built once and reused verbatim: two tools/list calls
 * answer byte-identical tools arrays. Property names are exactly the ones
 * github-mcp-server documents; the call path also accepts near-name
 * variants and a full_name, per the suite's argument mapping.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The owner (user or organization) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'get_issue',
    'Get a single issue by number.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch (with the changes).' },
      base: { type: 'string', description: 'The base branch (to merge into).' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'list_pull_requests',
    'List pull requests in a repository.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

// ---------------------------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------------------------

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Run one tool against the store. Never throws for a tool-level failure: it answers isError. */
function runTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (repoName === undefined) return errResult('Missing required argument: name');
      const owner = pickString(args, ['owner', 'owner_login', 'login']) ?? (store.owner !== '' ? store.owner : 'adaiversen');
      const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
      const isPrivate = pickBool(args, ['private', 'is_private']) ?? false;
      const repo = store.createRepo(owner, repoName, description, isPrivate);
      if (repo === null) return errResult(`Repository already exists: ${owner}/${repoName}`);
      return okResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const resolved = resolveOwnerRepo(args);
      if (resolved === null) return errResult('Missing required arguments: owner, repo');
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      return okResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const resolved = resolveOwnerRepo(args);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      if (resolved === null || title === undefined) {
        return errResult('Missing required arguments: owner, repo, title');
      }
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const issue = createIssueInStore(store, repo, title, body);
      return okResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const resolved = resolveOwnerRepo(args);
      if (resolved === null) return errResult('Missing required arguments: owner, repo');
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      const state = (pickString(args, ['state', 'status']) ?? 'open').toLowerCase();
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return okResult(list);
    }
    case 'get_issue': {
      const resolved = resolveOwnerRepo(args);
      const number = pickInt(args, ['issue_number', 'number', 'issueNumber']);
      if (resolved === null || number === undefined) {
        return errResult('Missing required arguments: owner, repo, issue_number');
      }
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      const issue = repo.issues.get(number);
      if (issue === undefined) return errResult(`Issue not found: #${number}`);
      return okResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const resolved = resolveOwnerRepo(args);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
      const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
      if (resolved === null || title === undefined || head === undefined || base === undefined) {
        return errResult('Missing required arguments: owner, repo, title, head, base');
      }
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const pull = createPullRequestInStore(store, repo, { title, body, head, base });
      if (pull === null) return errResult(`Could not resolve the head or base branch: ${head} / ${base}.`);
      return okResult(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const resolved = resolveOwnerRepo(args);
      if (resolved === null) return errResult('Missing required arguments: owner, repo');
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      const state = (pickString(args, ['state', 'status']) ?? 'open').toLowerCase();
      const list = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullJson(repo, pull));
      return okResult(list);
    }
    case 'merge_pull_request': {
      const resolved = resolveOwnerRepo(args);
      const number = pickInt(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      if (resolved === null || number === undefined) {
        return errResult('Missing required arguments: owner, repo, pull_number');
      }
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return errResult(`Repository not found: ${resolved.owner}/${resolved.repo}`);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return errResult(`Pull request not found: #${number}`);
      const oid = squashMergePullRequest(store, repo, pull);
      if (oid === null) return errResult(`Pull request #${number} cannot be merged.`);
      return okResult({ ...pullJson(repo, pull), merged: true, sha: oid });
    }
    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Dispatch one JSON-RPC request object. Returns the response object, or
 * null for a notification (no id), which gets no JSON-RPC response.
 */
function dispatch(store: Store, body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || typeof body.method !== 'string') {
    const id: JsonRpcId = isRecord(body) && (typeof body.id === 'string' || typeof body.id === 'number') ? body.id : null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  const method = body.method;
  const hasId = 'id' in body && (typeof body.id === 'string' || typeof body.id === 'number');
  const id: JsonRpcId = hasId ? (body.id as string | number) : null;
  // Notifications (no id) never get a JSON-RPC response.
  if (!hasId) return null;
  const params = isRecord(body.params) ? body.params : {};

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === '' || !TOOLS.some((t) => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name === '' ? '(missing name)' : name}`);
      }
      return rpcResult(id, runTool(store, name, args));
    }
    case 'resources/list': {
      return rpcResult(id, { resources: [] });
    }
    case 'prompts/list': {
      return rpcResult(id, { prompts: [] });
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point: POST /mcp
// ---------------------------------------------------------------------------------------------

/**
 * Handle POST /mcp. Returns true when the route was handled (even on
 * 401/400), false when the request is not for this endpoint.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp' && path !== '/mcp/') return false;
  // The client's close() sends DELETE on a legacy session: nothing to tear down.
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (Array.isArray(parsed)) {
    const out: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const r = dispatch(store, entry);
      if (r !== null) out.push(r);
    }
    sendJson(res, 200, out);
    return true;
  }
  const response = dispatch(store, parsed);
  if (response === null) {
    // Notification: 202 with an empty body.
    res.writeHead(202);
    res.end();
    return true;
  }
  sendJson(res, 200, response);
  return true;
}
