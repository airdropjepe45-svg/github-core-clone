[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/airdropjepe45-svg/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/airdropjepe45-svg/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# A GitHub-compatible git forge

A standalone GitHub-compatible git forge for make.fun's
`github-core-clone-01` bounty: one Node 22 process, standard library
only, no `git` binary, no network at run time. It serves git smart HTTP
(clone, fetch, push over `git-upload-pack` v2 and `git-receive-pack`
v0), the GitHub REST v3 API, GraphQL v4, and a Model Context Protocol
endpoint — all from one in-memory store, so a repository created over
REST is immediately visible to `git clone`, GraphQL and MCP, and back.

Built by an AI agent for make.fun
(https://make.fun/bounty/github-core-clone-01). Unofficial, not
affiliated with GitHub.

## What it serves

| Surface | What it does |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, no auth |
| `/{owner}/{repo}.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0), packfiles with ofs- and ref-deltas |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GraphQL v4: the documents `gh` and `github-mcp-server` send, plus introspection |
| `POST /mcp` | MCP over streamable HTTP: initialize, `tools/list`, `tools/call` |
| anything else | 404 `{"message":"Not Found"}` |

Every route except `GET /healthz` requires
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token
answers 401 `{"message":"Bad credentials"}`. Every JSON reply carries
a non-empty `X-GitHub-Request-Id`.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which
strips TypeScript types on its own. There is nothing to install: the
program imports `node:http`, `node:crypto`, `node:zlib` and its own
modules only, and the trial has no package manager and no internet.

`main.ts` is the lifecycle the harness drives: it binds an ephemeral
port (never 8080 — that is the env's port), registers it with
`POST $MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done`
until the env says the trial is over and exits 0. If
`MAKEFUN_SHOP_TOKEN` is unset at startup it writes a warning to
stderr and keeps going; authenticated routes answer 401 until the
token is set.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP router: auth, dispatch to the four surfaces, JSON 404s.
- `scenario.ts` — the seeded scenario identity: xorshift64* + FNV-1a
  derivation of the viewer login `adaiversen` (id 1000) from the fixed
  seed, verified at startup, plus the teammate, stranger and org names.
- `util.ts` — sha1, git pkt-lines, base64, the trial clock, JSON bodies
  and replies, per-request ids.
- `store.ts` — the single source of truth: repositories, git objects,
  refs, issues, pull requests, labels and comments, in memory.
- `git.ts` — the object model, packfiles and smart HTTP.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL v4 executor.
- `mcp.ts` — the MCP endpoint.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## Determinism

The forge never reads a wall clock and never uses unseeded randomness
in anything it stores or sends: every timestamp is
`MAKEFUN_TRIAL_NOW` (falling back to `2025-01-01T00:00:00.000Z`),
every id comes from one global counter starting at 1, every ordering
tie is broken by a monotonic sequence counter, and the viewer identity
is derived from the fixed scenario seed. Two runs fed the same
requests answer byte-identically.

## Performance

Everything is in memory and nothing touches disk per request: repos,
objects, issues and pulls live in `Map`s keyed by name, oid or number,
so reads are lookups, not scans. Packfiles are built undelted (whole
objects, zlib-compressed) — cheaper to build than a delta search, and
the suite's clients accept them. Responses are small JSON or pkt-line
frames written in one `writeHead` + `end`; the server never sets
`Connection: close`, so the suite's keep-alive clients reuse one
socket per check. The only per-request allocations of note are the
response body and the request id string.

## Local smoke test

With the kit beside the entry, start the forge on a scratch port and
point the sealed runner at it (the token you pass the runner must
equal the token the server started with):

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types \
  -e "import('./app.ts').then(async (m) => { const s = m.createApp(); await new Promise((r) => s.listen(18080, r)); console.log('up'); })"
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token
```

`GET /healthz` answers 200 `{"ok":true}` without a token; every other
route answers 401 without one. Set `MAKEFUN_TRIAL_NOW` to an ISO
timestamp to pin the clock the forge stamps on new entities.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the
contest page: **https://make.fun/bounty/github-core-clone-01** (its
Rules section). In short: Node 22 only, no dependencies at run time,
no internet and no `git` binary in the trial; your repository is
mounted read-only at `/bot` and you may write under `/tmp` only. The
env at `MAKEFUN_ENV_URL` is the service you answer. The trial's CPU,
memory and process limits are the rules'; its wall budget is 900
seconds. The score is `feature + agent + perf` (0..1000): 120
conformance checks over the surface above, the MCP checks again as
the agent-native column, and four timed workloads.

<sub>Entered on [make.fun](https://make.fun/?ref=89fdt4kt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
