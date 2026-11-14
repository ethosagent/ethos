// Local-tree and GitHub environments of scripts/catalog-import-hermes.ts.

import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  computeTreeDigest,
  fetchGitTreeDigest,
  withGitPinnedTree,
} from '@ethosagent/plugin-loader';
import {
  CONCURRENCY,
  type Env,
  type HermesEntry,
  type HermesSource,
  isObj,
  pool,
  RateLimitError,
  type Resolved,
} from './types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Local-tree environment (offline)
// ---------------------------------------------------------------------------

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(join(root, rel))) {
    if (rel === '' && name === '.git') continue;
    const r = rel === '' ? name : `${rel}/${name}`;
    const st = await lstat(join(root, r));
    if (st.isDirectory()) out.push(...(await walk(root, r)));
    else if (st.isFile()) out.push(r);
  }
  return out.sort();
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export function localEnv(
  sourceDir: string,
  treesDir: string,
  fake: Readonly<Record<string, Resolved>> = {},
): Env {
  const repoRoot = (e: HermesEntry): string => join(treesDir, e.owner, e.repo, e.sha);
  const subRoot = (e: HermesEntry): string => join(repoRoot(e), e.subdir);
  const source: HermesSource = {
    async entryFiles() {
      const dir = join(sourceDir, 'plugin-catalog');
      const names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
      return Promise.all(
        names.map(async (file) => ({ file, text: await readFile(join(dir, file), 'utf8') })),
      );
    },
    tree: (e) => walk(subRoot(e)),
    read: (e, rel) => readOrNull(join(subRoot(e), rel)),
    readRoot: (e, rel) => readOrNull(join(repoRoot(e), rel)),
    async rootFiles(e) {
      const root = repoRoot(e);
      const names = await readdir(root);
      const files: string[] = [];
      for (const n of names) if ((await lstat(join(root, n))).isFile()) files.push(n);
      return files.sort();
    },
  };
  return {
    source,
    async withTree(e, fn) {
      const dir = subRoot(e);
      return fn(dir, await computeTreeDigest(dir));
    },
    // No network in local-tree mode: resolution comes only from the test seam.
    resolveNpm: async (pkg) => fake[`npm:${pkg}`] ?? null,
    resolvePypi: async (pkg) => fake[`pypi:${pkg}`] ?? null,
  };
}

// ---------------------------------------------------------------------------
// GitHub environment (maintainer-run; exercised live, not by the offline tests)
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

export function githubEnv(
  hermesRepo: string,
  hermesCommit: string,
  token: string | undefined,
): Env {
  const headers = (raw: boolean): Record<string, string> => ({
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'User-Agent': 'ethos-catalog-import-hermes',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const get = async (url: string, raw: boolean): Promise<string | null> => {
    const res = await fetch(url, { headers: headers(raw), signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      throw new RateLimitError(
        `GitHub refused ${url} (${res.status}); set GITHUB_TOKEN or wait for the rate limit to reset`,
      );
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return res.text();
  };
  const trees = new Map<string, Promise<string[]>>();
  const repoTree = (e: HermesEntry): Promise<string[]> => {
    const key = `${e.owner}/${e.repo}@${e.sha}`;
    let p = trees.get(key);
    if (!p) {
      p = (async () => {
        const body = await get(
          `${GITHUB_API}/repos/${e.owner}/${e.repo}/git/trees/${e.sha}?recursive=1`,
          false,
        );
        if (body === null) throw new Error(`${key} not found`);
        const j: unknown = JSON.parse(body);
        if (!isObj(j) || !Array.isArray(j.tree))
          throw new Error(`${key} tree has an unexpected shape`);
        if (j.truncated === true) throw new Error(`${key} tree is truncated by the API`);
        return j.tree.flatMap((t: unknown) =>
          isObj(t) && t.type === 'blob' && typeof t.path === 'string' ? [t.path] : [],
        );
      })();
      trees.set(key, p);
    }
    return p;
  };
  const readPath = (e: HermesEntry, path: string): Promise<string | null> =>
    get(
      `${GITHUB_API}/repos/${e.owner}/${e.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${e.sha}`,
      true,
    );
  const source: HermesSource = {
    async entryFiles() {
      const listing = await get(
        `${GITHUB_API}/repos/${hermesRepo}/contents/plugin-catalog?ref=${hermesCommit}`,
        false,
      );
      if (listing === null)
        throw new Error(`plugin-catalog/ not found in ${hermesRepo}@${hermesCommit}`);
      const parsed: unknown = JSON.parse(listing);
      if (!Array.isArray(parsed))
        throw new Error('plugin-catalog/ listing has an unexpected shape');
      const names = parsed
        .flatMap((f: unknown) =>
          isObj(f) && f.type === 'file' && typeof f.name === 'string' && /\.ya?ml$/.test(f.name)
            ? [f.name]
            : [],
        )
        .sort();
      const texts = await pool(names, CONCURRENCY, async (file) => ({
        file,
        text: await get(
          `${GITHUB_API}/repos/${hermesRepo}/contents/plugin-catalog/${encodeURIComponent(file)}?ref=${hermesCommit}`,
          true,
        ),
      }));
      return texts.flatMap((t) => (t.text === null ? [] : [{ file: t.file, text: t.text }]));
    },
    async tree(e) {
      const prefix = e.subdir === '' ? '' : `${e.subdir}/`;
      return (await repoTree(e))
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    },
    read: (e, rel) => readPath(e, e.subdir === '' ? rel : `${e.subdir}/${rel}`),
    readRoot: (e, rel) => readPath(e, rel),
    async rootFiles(e) {
      return (await repoTree(e)).filter((p) => !p.includes('/'));
    },
  };
  const input = (e: HermesEntry) => ({
    repo: `https://github.com/${e.owner}/${e.repo}`,
    commit: e.sha,
    ...(e.subdir ? { subdir: e.subdir } : {}),
  });
  return {
    source,
    async withTree(e, fn) {
      const contentDigest = await fetchGitTreeDigest(input(e));
      return withGitPinnedTree({ ...input(e), contentDigest }, (dir) => fn(dir, contentDigest));
    },
    resolveNpm: resolveNpmReal,
    resolvePypi: resolvePypiReal,
  };
}

async function resolveNpmReal(pkg: string, version: string | null): Promise<Resolved | null> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', version ? `${pkg}@${version}` : pkg, 'version', 'dist.integrity', '--json'],
      { timeout: 60_000 },
    );
    const j: unknown = JSON.parse(stdout);
    const o: unknown = Array.isArray(j) ? j[j.length - 1] : j; // a range can match several versions
    return isObj(o) && typeof o.version === 'string' && typeof o['dist.integrity'] === 'string'
      ? { version: o.version, integrity: o['dist.integrity'] }
      : null;
  } catch {
    return null;
  }
}

async function resolvePypiReal(pkg: string, version: string | null): Promise<Resolved | null> {
  try {
    const url = version
      ? `https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`
      : `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const j: unknown = await res.json();
    if (
      !isObj(j) ||
      !isObj(j.info) ||
      typeof j.info.version !== 'string' ||
      !Array.isArray(j.urls)
    ) {
      return null;
    }
    for (const u of j.urls as unknown[]) {
      if (
        isObj(u) &&
        typeof u.filename === 'string' &&
        u.filename.endsWith('py3-none-any.whl') &&
        isObj(u.digests) &&
        typeof u.digests.sha256 === 'string'
      ) {
        return { version: j.info.version, integrity: `sha256-${u.digests.sha256}` };
      }
    }
    return null;
  } catch {
    return null;
  }
}
