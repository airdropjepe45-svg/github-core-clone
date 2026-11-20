// app.ts — the forge's HTTP router: one server, one store.
//
// Routes:
//   GET  /healthz                  200 {"ok":true}, no auth (the env's boot probe)
//   /api/v3*                       REST v3 (rest.ts)
//   POST /api/graphql              GraphQL v4 (graphql.ts)
//   POST /mcp                      MCP over streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/*          git smart HTTP (git.ts)
//   anything else                  404 {"message":"Not Found"}
//
// Auth: every route except GET /healthz requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; missing or wrong answers
// 401 {"message":"Bad credentials"}. A wrong owner in a path is the
// handlers' 404, never a 403. Bodies are capped at 10 MiB (see util.ts).
// Keep-alive friendly: no per-request `Connection: close`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { newStore, type Store } from './store.ts';
import { BodyError, sendJson } from './util.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query of a request URL, or empty params when it does not parse. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The bearer token on the request, or '' when the header is absent or malformed. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return '';
  return header.slice(prefix.length);
}

/** Decode one path segment, or '' when it is not valid percent-encoding. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * Match `/{owner}/{repo}.git/<rest>` and return its parts, or null when
 * the path is not a git smart-HTTP path.
 */
function gitPath(path: string): { owner: string; repoName: string; rest: string } | null {
  const segments = path.split('/').filter((part) => part !== '');
  if (segments.length < 2) return null;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = decodeSegment(segments[0] as string);
  const repoName = decodeSegment(repoSegment.slice(0, -'.git'.length));
  if (owner === '' || repoName === '') return null;
  return { owner, repoName, rest: segments.slice(2).join('/') };
}

/** Answer one request. Handlers run inside this try/catch: a BodyError becomes its status. */
async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Auth everywhere else: the token is read per request from the environment.
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '' || bearerToken(req) !== token) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  try {
    // GitHub REST v3, including the API root GET /api/v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (await handleRest(req, res, store)) return;
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GitHub GraphQL v4.
    if (method === 'POST' && path === '/api/graphql') {
      if (await handleGraphql(req, res, store)) return;
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // Model Context Protocol over streamable HTTP.
    if (method === 'POST' && path === '/mcp') {
      if (await handleMcp(req, res, store)) return;
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
    const git = gitPath(path);
    if (git !== null) {
      let service = queryOf(req).get('service') ?? '';
      if (git.rest === 'git-upload-pack') service = 'git-upload-pack';
      if (git.rest === 'git-receive-pack') service = 'git-receive-pack';
      await handleGit(req, res, store, git.owner, git.repoName, service);
      return;
    }
  } catch (err) {
    if (err instanceof BodyError) {
      if (!res.headersSent) sendJson(res, err.status, { message: err.message });
      return;
    }
    throw err;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = newStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res, store).catch((err: unknown) => {
      // A handler threw after the router's own catch: answer 500 if the
      // reply has not started, and log the failure for the operator.
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  });
}
