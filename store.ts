// store.ts — the forge's single source of truth: an in-memory store of
// repositories, git objects, issues, pull requests, labels and comments.
//
// Determinism rule: one global id counter (from 1) hands out every entity
// id, one global seq counter (from 1) breaks ordering ties, and every
// timestamp is trialNow(). Nothing here reads a clock or Math.random.

import { VIEWER_LOGIN, DEFAULT_BRANCH } from './scenario.ts';
import { sha1, trialNow } from './util.ts';

/** A git object id: 40 lowercase hex chars (a sha1). */
export type Oid = string;

/** One stored git object. */
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

/** One repository and everything inside it. */
export interface Repo {
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
  /** Git object store, by oid. */
  objects: Map<Oid, GitObject>;
  /** Refs: 'refs/heads/main' -> oid (heads and tags alike). */
  refs: Map<string, Oid>;
  issues: Map<number, Issue>;
  /** Next issue number to hand out (starts at 1). */
  issueSeq: number;
  pulls: Map<number, Pull>;
  /** Next pull request number to hand out (starts at 1). */
  pullSeq: number;
  /** Labels, keyed by name. */
  labels: Map<string, Label>;
  /** Next comment id to hand out within this repo (starts at 1). */
  commentSeq: number;
  /** Next label id to hand out within this repo (starts at 1). */
  labelSeq: number;
}

/** One issue. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  /** Monotonic ordering key, from the store's global seq counter. */
  seq: number;
  comments: IssueComment[];
}

/** One comment on an issue. */
export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic ordering key, from the store's global seq counter. */
  seq: number;
}

/** One label. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

/** One pull request. */
export interface Pull {
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
  /** Monotonic ordering key, from the store's global seq counter. */
  seq: number;
  files: PullFile[];
}

/** One changed file on a pull request. */
export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The whole forge, in memory. */
export class Store {
  /** Repositories, keyed `${owner}/${name}`. */
  repos: Map<string, Repo>;
  /** Next global entity id (starts at 1). */
  nextId: number;
  /** Next global ordering sequence (starts at 1). */
  nextSeq: number;
  /** The token owner's login. */
  owner: string;

  constructor() {
    this.repos = new Map<string, Repo>();
    this.nextId = 1;
    this.nextSeq = 1;
    this.owner = VIEWER_LOGIN;
  }

  /** The trial clock. */
  now(): string {
    return trialNow();
  }

  /** Hand out the next global entity id. */
  allocId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** Hand out the next global ordering sequence. */
  allocSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  /**
   * Create a repository, or `null` when `${owner}/${name}` already exists.
   * A new repo starts empty: no objects, no refs, no issues, no pulls.
   */
  createRepo(owner: string, name: string, description?: string, isPrivate?: boolean): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const now = this.now();
    const id = this.allocId();
    const repo: Repo = {
      id,
      databaseId: id,
      owner,
      name,
      fullName: key,
      description: description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      private: isPrivate ?? false,
      createdAt: now,
      updatedAt: now,
      objects: new Map<Oid, GitObject>(),
      refs: new Map<string, Oid>(),
      issues: new Map<number, Issue>(),
      issueSeq: 1,
      pulls: new Map<number, Pull>(),
      pullSeq: 1,
      labels: new Map<string, Label>(),
      commentSeq: 1,
      labelSeq: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** Look a repository up by owner and name. */
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** Delete a repository; `false` when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /**
   * Store a git object and return its oid:
   * sha1(`${type} ${data.length}\\0` + data).
   * Storing the same bytes twice returns the same oid.
   */
  putObject(repo: Repo, type: GitObject['type'], data: Buffer): Oid {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const oid = sha1(Buffer.concat([header, data]));
    repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Look a git object up by oid. */
  getObject(repo: Repo, oid: Oid): GitObject | undefined {
    return repo.objects.get(oid);
  }
}

/** A fresh, empty store. */
export function newStore(): Store {
  return new Store();
}
