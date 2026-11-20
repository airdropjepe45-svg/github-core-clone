# github-core-clone-01 — Architecture & module contract

Entry dir: `/home/hatch/workspace/makefun/github-core-clone-01/github-core-clone/`
Kit: `/home/hatch/workspace/makefun/github-core-clone-01/github-core-clone-01-kit/`
Deadline: 2026-11-21T06:30:00Z (13:30 WIB). Now ~03:07 WIB. Hand back a working entry by ~11:00 WIB.

## The one fact every module must know
The suite's checks address the token owner as the scenario viewer login **`adaiversen`**
(id 1000, name "ada iversen", email adaiversen@example.invalid). This is FIXED data:
the suite generates it from the constant seed `0x6a09e667f3bcc909n` via
xorshift64* + FNV-1a label seeding (`scenarioRng('users')` then `generateUsers(..., 12)`,
first user). The entry MUST answer with this login on GET /api/v3/user and
GraphQL `viewer { login }`, and must own repos under it. `scenario.ts` reimplements
that derivation from scratch (public-domain PRNG algorithm + the fixed name lists
from the kit's wire.ts, which are scenario data, not solution code) and MUST be
verified to yield `adaiversen`. Teammate `quinnkeller`, stranger `olgabauer`,
org `faint-meadow-org`. Default branch is `main`. Issue labels the suite uses:
`bug, enhancement, documentation, question, good first issue, help wanted`.

## Rules that bind every file
- Node 22, TypeScript, **stdlib only**. No `Date.now()`, no `Math.random()`, no
  `new Date()` in anything stored or sent. All timestamps = `MAKEFUN_TRIAL_NOW`
  (ISO string) via `trialNow()`; if unset, fall back to `2025-01-01T00:00:00.000Z`.
  Ordering ties are broken by a monotonic `seq` counter (deterministic: the suite
  drives checks one at a time; concurrent ops are reads only).
- One global id counter (starts at 1) hands out every entity id (repos, issues,
  PRs, comments, labels) — ids are unique, stable across reads, deterministic.
- Auth: every route except GET /healthz requires `Authorization: Bearer <token>`
  where token === `process.env.MAKEFUN_SHOP_TOKEN`. Missing/wrong → 401 JSON
  `{"message": "Bad credentials"}` (exact message text: check the clients for the
  expected wording; any JSON body with a string message is acceptable per RULES,
  but match the clients where they assert). Wrong owner in a path → 404, NEVER 403.
- Every REST reply: `Content-Type: application/json` and a non-empty
  `X-GitHub-Request-Id` header (use a per-request counter, e.g. `req-<n>` — deterministic).
  Unknown route → 404 JSON `{"message": "Not Found"}`. Malformed JSON body → 400 JSON.
- Files are flat in the entry root, imported as `./x.ts` (Node 22 strip-types).
  `main.ts` (starter lifecycle) stays UNCHANGED. `app.ts` is the router (CORE).
- Write ALL code from scratch with the file-write tool. NEVER copy code from any
  git implementation, the kit's reference forge, or another entry. Reading the
  kit's check/client files to learn the contract is REQUIRED — they are the spec.
  The starter files are the kit's own scaffold and are the base.

## Module map (each worker owns its files; do not edit another worker's files)
- `scenario.ts` (CORE): Rng (xorshift64*), fnv1a64, scenarioRng(label),
  generateUsers + FIRST_NAMES/LAST_NAMES lists; exports `VIEWER_LOGIN='adaiversen'`
  (computed, not a magic constant — assert it equals 'adaiversen' at startup),
  `VIEWER_ID=1000`, `VIEWER_NAME`, `VIEWER_EMAIL`, `DEFAULT_BRANCH='main'`.
- `util.ts` (CORE): `sha1(buf): string` (node:crypto), pkt-line encode/decode
  (`pktLine(s: string|Buffer): Buffer`, `pktFlush(): Buffer`, `parsePktLines(buf): (string|Buffer|null)[]`),
  `b64encode/b64decode`, `trialNow(): string`, `trialSeed(): string`,
  `jsonBody(req): Promise<unknown>` (400 on malformed), `sendJson(res, status, body, headers?)`,
  `requestId(): string` (counter).
- `store.ts` (CORE): the single source of truth. Exports:
  ```ts
  export type Oid = string; // 40-hex lowercase sha1
  export interface GitObject { type: 'blob'|'tree'|'commit'|'tag'; data: Buffer }
  export interface Repo {
    id: number; databaseId: number; owner: string; name: string; fullName: string;
    description: string; defaultBranch: string; private: boolean;
    createdAt: string; updatedAt: string;
    objects: Map<Oid, GitObject>;           // git object store
    refs: Map<string, Oid>;                 // 'refs/heads/main' -> oid (also tags)
    issues: Map<number, Issue>; issueSeq: number;
    pulls: Map<number, Pull>; pullSeq: number;
    labels: Map<string, Label>;             // keyed by name
    commentSeq: number; labelSeq: number;
  }
  export interface Issue { id: number; number: number; title: string; body: string;
    state: 'open'|'closed'; labels: string[]; createdAt: string; updatedAt: string;
    seq: number; comments: IssueComment[]; }
  export interface IssueComment { id: number; body: string; createdAt: string; updatedAt: string; seq: number; }
  export interface Label { id: number; name: string; color: string; description: string; }
  export interface Pull { id: number; number: number; title: string; body: string;
    state: 'open'|'closed'; merged: boolean; mergeable: boolean;
    head: { ref: string; sha: string }; base: { ref: string; sha: string };
    createdAt: string; updatedAt: string; seq: number; files: PullFile[]; }
  export interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number; }
  export class Store {
    repos: Map<string, Repo>;               // key `${owner}/${name}`
    nextId: number; nextSeq: number;        // global counters, start at 1
    owner: string;                          // VIEWER_LOGIN
    now(): string;
    allocId(): number; allocSeq(): number;
    createRepo(owner: string, name: string, description?: string, isPrivate?: boolean): Repo | null; // null if exists
    getRepo(owner: string, name: string): Repo | undefined;
    deleteRepo(owner: string, name: string): boolean;
    listRepos(owner: string): Repo[];
    putObject(repo: Repo, type: GitObject['type'], data: Buffer): Oid; // sha1(type + ' ' + len + '\0' + data)
    getObject(repo: Repo, oid: Oid): GitObject | undefined;
  }
  export function newStore(): Store;
  ```
  Repo JSON shape for REST (what the checks read — worker REST must match
  `checks-rest.ts`/`rest-client.ts` exactly): `{id, node_id, name, full_name,
  owner: {login, id, type: 'User'}, private, description, default_branch,
  created_at, updated_at, html_url, clone_url, git_url, ssh_url, homepage: null,
  language: null, ...}` — include the fields the clients assert; extra fields are fine.
- `git.ts` (GIT): object model + packfile + smart HTTP. Exports:
  ```ts
  export function parseCommit(data: Buffer): { tree: Oid; parents: Oid[]; author: string; committer: string; message: string };
  export function buildCommit(tree: Oid, parents: Oid[], author: string, committer: string, message: string): Buffer;
  export function parseTree(data: Buffer): { mode: string; name: string; oid: Oid }[];
  export function buildTree(entries: { mode: string; name: string; oid: Oid }[]): Buffer;
  export function parsePack(buf: Buffer): Map<Oid, GitObject>; // v2/v3, ofs-delta + ref-delta, zlib
  export function buildPack(objects: Map<Oid, GitObject>): Buffer; // undelted entries are fine
  export function collectReachable(repo: Repo, tips: Oid[]): Map<Oid, GitObject>;
  export function isAncestor(repo: Repo, ancestor: Oid, tip: Oid): boolean;
  export function handleGit(req, res, store: Store, owner: string, repoName: string, service: string): Promise<void>;
  // handleGit serves: GET /info/refs?service=git-upload-pack|git-receive-pack,
  // POST /git-upload-pack (v2 if Git-Protocol: version=2 else v0),
  // POST /git-receive-pack (v0). 404 for missing repo. Auth via Bearer (same token).
  ```
- `rest.ts` (REST): `export function handleRest(req, res, store: Store): Promise<boolean>`
  (returns true if it handled the route). All /api/v3 endpoints incl.
  GET /api/v3 (200 + X-OAuth-Scopes), GET /api/v3/meta (installed_version non-empty),
  GET /api/v3/user (login adaiversen), GET/POST /api/v3/user/repos (201, Link rel=next),
  GET/PATCH/DELETE /api/v3/repos/{o}/{r}, PUT/DELETE contents (201/200/409; DELETE 200 {commit:{sha}}),
  GET/POST issues + comments, POST labels (201; issues 422 on unknown label),
  POST/GET pulls, PUT merge (200 {sha, merged:true, message}; squash commit on default
  branch; 404 unknown, 405 conflicted), branches/commits reads the checks need
  (read checks-rest.ts for the exact list), unknown route 404 JSON, malformed JSON 400.
  Contents PUT creates blob+tree+commit on the branch (default branch or ?ref=).
  Merge: squash = one commit whose tree = head tree, parent = base tip, on base branch.
- `graphql.ts` (GQL): `export function handleGraphql(req, res, store: Store): Promise<boolean>`
  POST /api/graphql. Mini executor for EXACTLY the documents in
  `GRAPHQL_DOCUMENTS` (checks-graphql.ts): viewerLogin, repositoryFields, issueFields,
  typeFields, searchTypeEnumValues, openIssues, issueByNumber, createIssue, closeIssue,
  pullRequests, pullRequestFiles, pullRequestId, createPullRequest, mergePullRequest,
  addComment, invalidField, nodeRepository, issuesPage. Introspection must describe
  Issue/PullRequest/Repository fields + SearchType enumValues incl. ISSUE.
  `repository.issues(orderBy: {field: CREATED_AT, direction: DESC})` → numbers DESC,
  ties by number DESC; `states: [OPEN]` omits closed. Unknown field → HTTP 200 with
  `errors` array naming it. Unknown repo → `data.repository = null`, no errors.
  Two operations in one body → array of two results in order. Unauthenticated → 401.
- `mcp.ts` (GQL): `export function handleMcp(req, res, store: Store): Promise<boolean>`
  POST /mcp. JSON-RPC 2.0 Streamable HTTP. `initialize` (protocolVersion negotiation;
  answer `protocolVersion` echo + capabilities + serverInfo), `notifications/initialized`
  (no reply / 202), `server/discover` (result.supportedVersions = non-empty list of
  YYYY-MM-DD revisions incl. 2026-07-28), `tools/list` (≥6 tools incl. create_repo,
  get_repo, create_issue, list_issues, create_pull_request, merge_pull_request;
  non-empty description + inputSchema {type:'object'} each; byte-identical across calls),
  `tools/call` (args as github-mcp-server documents; map args onto schema property names;
  fill full_name = owner/repo; concurrent calls keep their own ids).
  Unknown tool → -32602 or -32601 (never HTTP 500). Missing required arg → isError:true
  or -32602. Non-JSON body → HTTP 400 with -32700. No Authorization → 401. Each request <3s.
  Tools act on the SAME store as REST (ids unchanged across reads).
- `app.ts` (CORE): `export function createApp(): Server` — one http server, routes:
  GET /healthz → 200 {ok:true} (no auth); /api/v3* → rest; POST /api/graphql → graphql;
  POST /mcp → mcp; /{owner}/{repo}.git/* → git; else 404 JSON. Auth enforced everywhere
  except /healthz. Body reading with a sane cap (10 MiB). Keep-alive friendly (no
  per-request `Connection: close`). Never bind 8080 (main.ts listens on 0).

## How each worker verifies its own module
- Read the matching check file(s) + client file(s) FIRST (they are the spec):
  GIT → checks-git.ts + git-client.ts; REST → checks-rest.ts + rest-client.ts;
  GQL → checks-graphql.ts + graphql-client.ts; MCP → checks-mcp.ts + mcp-client.ts.
  CORE → wire.ts (scenarioRng/Rng/generateUsers), manifest.ts (counts), main.ts (lifecycle).
- Local test path (no docker): start your module's server with node, then run the
  sealed runner: `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token <any-token-you-set-as-MAKEFUN_SHOP_TOKEN> [--perf] [--json]`
  (sdk/run.ts in the kit; it runs the sealed checks against any server). The token you
  pass to run.ts must equal the MAKEFUN_SHOP_TOKEN your server was started with.
- The entry's server is started as `MAKEFUN_SHOP_TOKEN=<tok> node --experimental-strip-types main.ts`
  (main.ts needs MAKEFUN_ENV_URL only for register/done; for local testing, run
  app.ts's server directly on a fixed port instead — write a tiny throwaway test
  script in /tmp, never in the entry dir).

## Integration (coordinator does this after workers report)
- `node --experimental-strip-types main.ts` must start, bind port 0, and (with a
  fake MAKEFUN_ENV_URL) register + poll. Full run: env server.mjs + entry + sdk/run.ts.
- Target: ≥100/120 conformance, MCP 15/15, perf as fast as the machine allows
  (in-memory store, no per-request disk sync).
