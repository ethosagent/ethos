// ---------------------------------------------------------------------------
// Git pins — the catalog's `pin: { type: 'git' }` (unified-catalog D15)
// ---------------------------------------------------------------------------
//
// A pin is a GitHub repo + a 40-hex commit + Ethos's own `contentDigest` of the
// files under `subdir`. The digest is checked AFTER the fetch whatever the
// transport, so the guarantee does not rest on git, GitHub or an archive
// format being byte-stable: the commit id says what to ask for, the digest says
// what we accept.
//
//   contentDigest = "sha256-" + base64(sha256(lines))
//   lines         = one per regular file under subdir, sorted by relative path
//                   (UTF-8 byte order), each `<path>\0<x|->\0<sha256 hex>\n`
//                   with `/` separators, `x` when the owner-exec bit is set.
//
// Fetch: `git init` + `git fetch --depth 1 <repo> <commit>` + `git checkout
// FETCH_HEAD` in an `os.tmpdir()` scratch directory, removed in a `finally`.
// Verified live (2026-11-05) that GitHub serves a fetch by full SHA for a
// reachable commit; a commit that is not reachable fails the fetch, which is
// `GitPinFetchError`. Git is spawned with an argv array (no shell) behind an
// injected `GitRunner`, like `NpmRunner` in tarball-pin.ts.
//
// Refused before `fn` runs, all as `GitPinRefusedError`: a symlink or a
// submodule (a gitlink in the subtree, or a root `.gitmodules`) anywhere under
// the subtree, a file over 1 MiB, more than 2000 files, an empty subtree.
// Enforced by the walk in `computeTreeDigest` and the `ls-tree` check in
// `fetchTree`; pinned by __tests__/git-pin.test.ts.
//
// Raw `node:fs` here is the scratch directory and nothing else, never
// `~/.ethos/` (AGENTS.md, Storage exceptions): `git checkout` writes a tree
// of files and Storage has no way to name a path an external binary writes
// into. Same scratch rationale as `withPackedTarball` in tarball-pin.ts.
//
// Known limits, stated rather than hidden:
//   * Only `https://github.com/<owner>/<repo>`; no other host or scheme.
//   * The digest covers file paths, the owner-exec bit and content. It does not
//     cover git metadata (commit message, author) or files outside `subdir`.
//   * A file whose content git rewrites on checkout (a `.gitattributes`
//     `eol`/`filter` rule) is digested as written to disk, which is
//     deterministic for the repo's own attributes because the user and system
//     git config are disabled (`execGit`), but is not the blob bytes.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafePathSegment } from '@ethosagent/storage-fs';

/**
 * Runs git with an argv array in `cwd` and resolves with its stdout. Injected
 * by tests; production uses `execGit`.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const GIT_TIMEOUT_MS = 120_000;

/**
 * git through `execFile` with an argv array: no shell, nothing to escape.
 * User and system git config are switched off (no `url.*.insteadOf`
 * rewriting to another host, no hooks, no credential helper) and only https
 * may be spoken. `GIT_TERMINAL_PROMPT=0` makes a private or missing repo fail
 * rather than ask for a password.
 */
export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'credential.helper=',
        ...args,
      ],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

export const MAX_GIT_PIN_FILE_BYTES = 1024 * 1024;
export const MAX_GIT_PIN_FILES = 2000;

/** Base class: every typed failure of this module. */
export class GitPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitPinError';
  }
}

/** A malformed pin (repo, commit, subdir or digest). Thrown before git is spawned. */
export class GitPinInputError extends GitPinError {
  constructor(message: string) {
    super(message);
    this.name = 'GitPinInputError';
  }
}

/** git could not produce the commit: unreachable, deleted, network, or not a GitHub repo. */
export class GitPinFetchError extends GitPinError {
  constructor(message: string) {
    super(message);
    this.name = 'GitPinFetchError';
  }
}

/** The fetched tree is not one we accept (symlink, submodule, oversize, empty). */
export class GitPinRefusedError extends GitPinError {
  constructor(message: string) {
    super(message);
    this.name = 'GitPinRefusedError';
  }
}

/** The fetched tree's digest differs from the pin. Nothing was handed to `fn`. */
export class GitPinMismatchError extends GitPinError {
  readonly expected: string;
  readonly actual: string;
  constructor(repo: string, commit: string, expected: string, actual: string) {
    super(
      `Refusing ${repo}@${commit}: the fetched tree's digest ${actual} does not match the pinned ${expected}. Either the repository served different bytes for this commit or the pinned digest does not describe it. Nothing was installed.`,
    );
    this.name = 'GitPinMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export interface GitPinInput {
  /** `https://github.com/<owner>/<repo>` and nothing else. */
  repo: string;
  /** Full 40-hex lowercase commit id. */
  commit: string;
  /** Directory inside the repo; the digest and `fn`'s `dir` are scoped to it. */
  subdir?: string;
}

export interface GitPinVerifyInput extends GitPinInput {
  /** `sha256-<base64>`. */
  contentDigest: string;
}

export interface GitPinDeps {
  runGit?: GitRunner;
}

const GITHUB_PREFIX = 'https://github.com/';
// A GitHub login or repo name: letters, digits, `-`, `_`, `.`. The segment
// must also pass `isSafePathSegment` (no `..`, no leading `.`).
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** True for `https://github.com/<owner>/<repo>` with safe owner and repo segments. */
export function isGithubRepoUrl(repo: string): boolean {
  if (!repo.startsWith(GITHUB_PREFIX)) return false;
  const parts = repo.slice(GITHUB_PREFIX.length).split('/');
  if (parts.length !== 2) return false;
  return parts.every((p) => GITHUB_NAME_RE.test(p) && isSafePathSegment(p));
}

function validateInput(input: GitPinInput): string[] {
  if (!isGithubRepoUrl(input.repo)) {
    throw new GitPinInputError(
      `Refusing git pin repo "${input.repo}": only https://github.com/<owner>/<repo> is supported`,
    );
  }
  if (!COMMIT_RE.test(input.commit)) {
    throw new GitPinInputError(
      `Refusing git pin commit "${input.commit}": a full 40-character lowercase hex commit id is required`,
    );
  }
  const segments = input.subdir === undefined ? [] : input.subdir.split('/');
  if (input.subdir !== undefined && !segments.every((s) => isSafePathSegment(s))) {
    throw new GitPinInputError(
      `Refusing git pin subdir "${input.subdir}": each segment must be a plain directory name`,
    );
  }
  return segments;
}

interface TreeEntry {
  path: string;
  executable: boolean;
  sha256: string;
}

/** One regular file of a verified tree: its path relative to the pinned directory and its owner-exec bit. */
export interface GitPinnedFile {
  path: string;
  executable: boolean;
}

/** The digest of a list of files; exported so the algorithm has one definition. */
export function digestOfEntries(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );
  const h = createHash('sha256');
  for (const e of sorted) h.update(`${e.path}\0${e.executable ? 'x' : '-'}\0${e.sha256}\n`);
  return `sha256-${h.digest('base64')}`;
}

/**
 * Walk `root` and digest every regular file. Refuses (GitPinRefusedError) any
 * symlink or other non-regular entry, any file over `MAX_GIT_PIN_FILE_BYTES`,
 * more than `MAX_GIT_PIN_FILES` files, and an empty tree. A top-level `.git`
 * is skipped (present when no `subdir` was given).
 */
export async function computeTreeDigest(root: string): Promise<string> {
  return (await scanTree(root)).digest;
}

/** `computeTreeDigest` plus the file manifest the digest covers, sorted by path. */
async function scanTree(root: string): Promise<{ digest: string; files: GitPinnedFile[] }> {
  const entries: TreeEntry[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (rel === '' && name === '.git') continue;
      const abs = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new GitPinRefusedError(`Refusing pinned tree: "${relPath}" is a symlink`);
      }
      if (st.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!st.isFile()) {
        throw new GitPinRefusedError(`Refusing pinned tree: "${relPath}" is not a regular file`);
      }
      if (st.size > MAX_GIT_PIN_FILE_BYTES) {
        throw new GitPinRefusedError(
          `Refusing pinned tree: "${relPath}" is ${st.size} bytes, over the ${MAX_GIT_PIN_FILE_BYTES}-byte limit`,
        );
      }
      if (entries.length >= MAX_GIT_PIN_FILES) {
        throw new GitPinRefusedError(`Refusing pinned tree: more than ${MAX_GIT_PIN_FILES} files`);
      }
      const sha256 = createHash('sha256')
        .update(await readFile(abs))
        .digest('hex');
      entries.push({ path: relPath, executable: (st.mode & 0o100) !== 0, sha256 });
    }
  };
  await walk(root, '');
  if (entries.length === 0) throw new GitPinRefusedError('Refusing pinned tree: it has no files');
  return {
    digest: digestOfEntries(entries),
    files: entries
      .map(({ path, executable }) => ({ path, executable }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
  };
}

/** Refuse symlinks and gitlinks recorded in the commit's tree (not just those that materialised). */
function checkLsTree(lsTree: string, subdir: string | undefined): void {
  const prefix = subdir === undefined ? '' : `${subdir}/`;
  for (const rec of lsTree.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    const mode = rec.slice(0, rec.indexOf(' '));
    const path = rec.slice(tab + 1);
    if (path === '.gitmodules') {
      throw new GitPinRefusedError('Refusing pinned tree: the repository has a .gitmodules file');
    }
    if (prefix !== '' && !path.startsWith(prefix)) continue;
    if (mode === '160000') {
      throw new GitPinRefusedError(`Refusing pinned tree: "${path}" is a submodule`);
    }
    if (mode === '120000') {
      throw new GitPinRefusedError(`Refusing pinned tree: "${path}" is a symlink`);
    }
  }
}

async function withFetchedTree<T>(
  input: GitPinInput,
  deps: GitPinDeps,
  use: (dir: string) => Promise<T>,
): Promise<T> {
  const segments = validateInput(input);
  const runGit = deps.runGit ?? execGit;
  const scratch = await mkdtemp(join(tmpdir(), 'ethos-git-pin-'));
  try {
    try {
      await runGit(['init', '-q'], scratch);
      await runGit(['fetch', '-q', '--depth', '1', '--no-tags', input.repo, input.commit], scratch);
      await runGit(['checkout', '-q', 'FETCH_HEAD'], scratch);
    } catch (err) {
      throw new GitPinFetchError(
        `Could not fetch ${input.repo} at ${input.commit}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const head = (await runGit(['rev-parse', 'HEAD'], scratch)).trim();
    if (head !== input.commit) {
      throw new GitPinFetchError(
        `Fetched ${input.repo} but HEAD is ${head}, not the pinned ${input.commit}`,
      );
    }
    checkLsTree(await runGit(['ls-tree', '-r', '-z', 'HEAD'], scratch), input.subdir);

    // Every segment below the repo root must be a real directory: a symlinked
    // parent would let the walk read outside the checkout.
    let dir = scratch;
    for (const seg of segments) {
      dir = join(dir, seg);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(dir);
      } catch {
        throw new GitPinRefusedError(
          `Pinned subdir "${input.subdir}" does not exist at the commit`,
        );
      }
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new GitPinRefusedError(`Pinned subdir "${input.subdir}" is not a plain directory`);
      }
    }
    return await use(dir);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Fetch the pinned tree, verify its digest, and hand its directory and the
 * verified file manifest (the exact files the digest covers) to `fn`.
 * The directory is deleted when `fn` settles. Throws `GitPinInputError`
 * (malformed pin, before git runs), `GitPinFetchError`, `GitPinRefusedError`
 * or `GitPinMismatchError` (digest differs: `fn` is never called).
 */
export async function withGitPinnedTree<T>(
  input: GitPinVerifyInput,
  fn: (dir: string, files: readonly GitPinnedFile[]) => Promise<T>,
  deps: GitPinDeps = {},
): Promise<T> {
  if (!DIGEST_RE.test(input.contentDigest)) {
    throw new GitPinInputError(
      `Refusing git pin contentDigest "${input.contentDigest}": expected sha256-<base64>`,
    );
  }
  return withFetchedTree(input, deps, async (dir) => {
    const { digest: actual, files } = await scanTree(dir);
    if (actual !== input.contentDigest) {
      throw new GitPinMismatchError(input.repo, input.commit, input.contentDigest, actual);
    }
    return fn(dir, files);
  });
}

/**
 * Fetch a tree and return its digest without comparing: how a maintainer
 * computes the `contentDigest` for a new catalog entry. Same refusals as
 * `withGitPinnedTree`.
 */
export async function fetchGitTreeDigest(
  input: GitPinInput,
  deps: GitPinDeps = {},
): Promise<string> {
  return withFetchedTree(input, deps, computeTreeDigest);
}
