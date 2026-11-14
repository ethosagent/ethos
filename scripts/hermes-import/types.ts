// Shared types and helpers of scripts/catalog-import-hermes.ts.

import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const BUCKETS = ['portable-mcp', 'portable-skills', 'python-only', 'other'] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface HermesEntry {
  name: string;
  owner: string;
  repo: string;
  sha: string;
  subdir: string;
  /** The Hermes tier, verbatim; only ever reported, never copied (D24). */
  hermesTier: string;
  category: string;
}

export type McpServerPlan =
  | { kind: 'remote'; name: string; url: string }
  | {
      kind: 'package';
      name: string;
      ecosystem: 'npm' | 'pypi';
      pkg: string;
      version: string | null;
      argsAfterSpec: string[];
      env: string[];
    };

export interface Classified {
  entry: HermesEntry;
  bucket: Bucket;
  reason: string;
  servers: McpServerPlan[];
  skillPaths: string[];
  /** portable-mcp only: every server is a remote url or names an exact version. */
  pinnable: boolean;
}

export interface Resolved {
  version: string;
  integrity: string;
}

/** Reads entries and trees; local-tree mode and the GitHub API both implement it. */
export interface HermesSource {
  entryFiles(): Promise<Array<{ file: string; text: string }>>;
  /** Regular files under the entry's subdir, relative to it. */
  tree(e: HermesEntry): Promise<string[]>;
  /** A file under the subdir, or null when absent. */
  read(e: HermesEntry, rel: string): Promise<string | null>;
  /** A file at the repository root, or null when absent. */
  readRoot(e: HermesEntry, rel: string): Promise<string | null>;
  /** Regular files at the top level of the repository. */
  rootFiles(e: HermesEntry): Promise<string[]>;
}

export interface Env {
  source: HermesSource;
  /** Run `fn` over the entry's pinned directory and its contentDigest. */
  withTree<T>(e: HermesEntry, fn: (dir: string, digest: string) => Promise<T>): Promise<T>;
  /** Exact version + integrity; version null means "latest". null when unavailable. */
  resolveNpm(pkg: string, version: string | null): Promise<Resolved | null>;
  resolvePypi(pkg: string, version: string | null): Promise<Resolved | null>;
}

export class UsageError extends Error {}
export class RateLimitError extends Error {}

export function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** Untrusted text for markdown or a source comment: one line, a tame charset. */
export function safe(s: string, max = 200): string {
  return oneLine(s, max).replace(/[^\w .,:;/@()+=\-"']/g, '?');
}

/** `fn` over `items`, `limit` at a time; results keep the input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const CONCURRENCY = 8;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try {
    const d = parseYaml(m[1] as string);
    return isObj(d) ? d : null;
  } catch {
    return null;
  }
}
