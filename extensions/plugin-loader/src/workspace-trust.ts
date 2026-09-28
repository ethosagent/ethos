// ---------------------------------------------------------------------------
// Workspace plugin trust (UBP-009, owner decision D4)
// ---------------------------------------------------------------------------
//
// A plugin inside the WORKING DIRECTORY — `<cwd>/.ethos/plugins/<name>/` or a
// `<cwd>/node_modules/{ethos-plugin-*,@ethos-plugins/*,@ethosagent/*}` package
// — arrived with whatever repo was cloned, not by an install decision. Before
// this, `PluginLoader.loadAll` imported it on every start of every surface
// (chat, serve, gateway, an IDE-spawned `ethos acp`), so opening a hostile repo
// ran its code with the user's keys. It now loads only after an explicit grant
// for THAT directory with THAT content: `ethos plugin trust [dir]` records the
// directory and a hash of its files, and any later edit to them (including a
// `git pull`) voids the grant until the operator trusts it again.
//
// Enforced by `PluginLoader.workspaceGate` (./index.ts), pinned by
// `__tests__/workspace-trust.test.ts`.
//
// The hash covers every file under the plugin directory, a nested
// `node_modules/` included, EXCEPT `.git/` (`hashPluginTree`). Nothing outside
// that tree may execute or contribute skills under the grant, so it cannot
// change behind it:
//   - imports: a trusted workspace plugin's module graph is contained to its
//     folder — any resolution to a file outside it (a relative `../lib/x.js`, an
//     absolute path, a dependency hoisted to `<cwd>/node_modules` or a pnpm
//     sibling, a symlink pointing out) is refused before it evaluates
//     (`guardWorkspacePluginImports`, ./workspace-import-guard.ts);
//   - skills: a `skills_dir` that resolves outside the folder refuses the
//     plugin (`PluginLoader.workspaceSkillsDirEscapes`, ./index.ts).
// A symlink inside the folder is hashed as its link text, and one that points
// outside the folder, or into the unhashed `.git/` (V3-7), refuses the grant
// (`hashPluginTree`). Not covered: `node:` builtins and the Ethos
// process itself — what the plugin is handed through `activate(api)`.
//
// Like the capability grant in ./grants.ts this is a consent record, not a
// sandbox: a trusted plugin runs in-process with full privileges.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Storage } from '@ethosagent/types';

const TRUST_FILE = 'workspace-trust.json';

/** One grant: the plugin directory (absolute) → the content hash it was trusted at. */
export interface WorkspaceTrustGrant {
  hash: string;
  grantedAt: string;
}

export type WorkspaceTrustGrants = Record<string, WorkspaceTrustGrant>;

export type WorkspaceTrustState = 'trusted' | 'untrusted' | 'changed';

/** `<pluginsDir>/workspace-trust.json` — next to `grants.json`. */
export function workspaceTrustPath(pluginsDir: string): string {
  return join(pluginsDir, TRUST_FILE);
}

/** Read the grant map. A missing or unreadable file is "nothing trusted" —
 *  the fail-closed reading of a trust record. */
export async function readWorkspaceTrust(
  storage: Storage,
  pluginsDir: string,
): Promise<WorkspaceTrustGrants> {
  const raw = await storage.read(workspaceTrustPath(pluginsDir));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: WorkspaceTrustGrants = {};
    for (const [dir, grant] of Object.entries(parsed as Record<string, unknown>)) {
      if (!grant || typeof grant !== 'object') continue;
      const { hash, grantedAt } = grant as Record<string, unknown>;
      if (typeof hash === 'string' && typeof grantedAt === 'string') {
        out[dir] = { hash, grantedAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeWorkspaceTrust(
  storage: Storage,
  pluginsDir: string,
  grants: WorkspaceTrustGrants,
): Promise<void> {
  await storage.mkdir(pluginsDir);
  await storage.writeAtomic(workspaceTrustPath(pluginsDir), `${JSON.stringify(grants, null, 2)}\n`);
}

/**
 * sha256 over the plugin directory's files — sorted relative paths and their
 * bytes, a nested `node_modules/` included (a trusted plugin may only import
 * from inside its folder, so its dependencies live there), `.git/` skipped.
 * Any added, removed, renamed or edited file changes it.
 *
 * A symbolic link (V2-RT-2) is hashed as its link TEXT and never read through:
 * pnpm links each dependency as a directory symlink
 * (`node_modules/dep -> .pnpm/dep@1.0.0/node_modules/dep`), whose real files
 * are hashed where they live, so retargeting a link or editing its target both
 * change the hash. A link whose target resolves outside the folder throws —
 * the grant could not cover what it names, and the import guard
 * (`guardWorkspacePluginImports`, ./workspace-import-guard.ts) would refuse
 * it at load anyway. So does one whose target resolves into `.git/` (V3-7):
 * that subtree is not hashed, so the file it names could change under the
 * grant. Pinned by `__tests__/workspace-trust.test.ts` ('workspace plugin
 * trust over symlinks').
 */
export async function hashPluginTree(storage: Storage, dir: string): Promise<string> {
  const root = resolve(dir);
  const realRoot = await realpath(root).catch(() => root);
  const files: string[] = [];
  const links = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    const entries = await storage.listEntries(current).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      const target = await symlinkTarget(full);
      if (target !== undefined) {
        await assertLinkContained(full, target, root, realRoot);
        links.set(full, target);
      } else if (entry.isDir) {
        if (entry.name === '.git') continue;
        await walk(full);
      } else {
        files.push(full);
      }
    }
  };
  await walk(root);
  const paths = [...files, ...links.keys()].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(relative(root, path));
    hash.update('\0');
    const target = links.get(path);
    if (target !== undefined) hash.update(`symlink:${target}`);
    else hash.update((await storage.readBytes(path)) ?? new Uint8Array());
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

/**
 * The link text when `path` is a symbolic link, else undefined. Raw `node:fs`
 * (`lstat`/`readlink`/`realpath`): `Storage` follows symlinks and has no
 * `lstat`, and the path is a workspace plugin folder, not `~/.ethos` state
 * (extensions/plugin-loader is on the no-raw-fs prefix allowlist). A path the
 * real filesystem does not know (an in-memory Storage) is not a link.
 */
async function symlinkTarget(path: string): Promise<string | undefined> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isSymbolicLink()) return undefined;
  return readlink(path);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertLinkContained(
  link: string,
  target: string,
  root: string,
  realRoot: string,
): Promise<void> {
  // The resolved target decides when it exists (the import guard compares
  // realpaths too); a dangling link is judged by where its text points.
  const real = await realpath(link).catch(() => undefined);
  const [base, resolved] =
    real !== undefined ? [realRoot, real] : [root, resolve(dirname(link), target)];
  if (!isInside(base, resolved)) {
    throw new Error(
      `symlink ${relative(root, link)} -> ${target} points outside the plugin folder ${root}; a workspace plugin trust grant covers only files inside its folder. Vendor the target into the folder (or remove the link), then run: ethos plugin trust`,
    );
  }
  // V3-7: `.git/` is the one subtree the hash skips, and a link is hashed as
  // its text, so a link into it would let the code it names change under the
  // grant. Checked on the RESOLVED path, so a chain of links is caught too.
  if (relative(base, resolved).split(sep).includes('.git')) {
    throw new Error(
      `symlink ${relative(root, link)} -> ${target} points into .git/, which a workspace plugin trust grant does not cover. Vendor the target outside .git/ (or remove the link), then run: ethos plugin trust`,
    );
  }
}

/** Whether `dir` is trusted at its CURRENT content. */
export async function workspaceTrustState(
  storage: Storage,
  pluginsDir: string,
  dir: string,
): Promise<WorkspaceTrustState> {
  const grant = (await readWorkspaceTrust(storage, pluginsDir))[resolve(dir)];
  if (!grant) return 'untrusted';
  return grant.hash === (await hashPluginTree(storage, dir)) ? 'trusted' : 'changed';
}

/** Record a grant for `dir` at its current content. Returns the hash trusted. */
export async function trustWorkspacePlugin(
  storage: Storage,
  pluginsDir: string,
  dir: string,
  now: Date = new Date(),
): Promise<string> {
  const hash = await hashPluginTree(storage, dir);
  const grants = await readWorkspaceTrust(storage, pluginsDir);
  grants[resolve(dir)] = { hash, grantedAt: now.toISOString() };
  await writeWorkspaceTrust(storage, pluginsDir, grants);
  return hash;
}

/** Withdraw the grant for `dir`. Returns whether one existed. */
export async function untrustWorkspacePlugin(
  storage: Storage,
  pluginsDir: string,
  dir: string,
): Promise<boolean> {
  const grants = await readWorkspaceTrust(storage, pluginsDir);
  const key = resolve(dir);
  if (!grants[key]) return false;
  delete grants[key];
  await writeWorkspaceTrust(storage, pluginsDir, grants);
  return true;
}

/**
 * Package names under a PROJECT `node_modules` the loader considers:
 * `ethos-plugin-*`, `@ethos-plugins/*` and `@ethosagent/*`. The one filter for
 * `PluginLoader` and `ethos plugin trust`, so what the CLI offers to trust is
 * exactly what the loader would load.
 */
export async function projectNodeModulesCandidates(
  storage: Storage,
  nmDir: string,
): Promise<string[]> {
  const entries = await storage.list(nmDir);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('ethos-plugin-')) {
      candidates.push(entry);
      continue;
    }
    if (entry === '@ethos-plugins' || entry === '@ethosagent') {
      for (const sub of await storage.list(join(nmDir, entry))) {
        candidates.push(`${entry}/${sub}`);
      }
    }
  }
  return candidates;
}

/**
 * Every workspace plugin directory under `cwd` the loader would consider:
 * each subdirectory of `<cwd>/.ethos/plugins/`, and each candidate package in
 * `<cwd>/node_modules/` that has a `package.json`.
 */
export async function discoverWorkspacePluginDirs(
  storage: Storage,
  cwd: string,
): Promise<string[]> {
  const dirs: string[] = [];
  const projectPlugins = join(cwd, '.ethos', 'plugins');
  for (const entry of await storage.listEntries(projectPlugins).catch(() => [])) {
    if (entry.isDir) dirs.push(join(projectPlugins, entry.name));
  }
  const nmDir = join(cwd, 'node_modules');
  for (const name of await projectNodeModulesCandidates(storage, nmDir)) {
    const dir = join(nmDir, name);
    if (await storage.exists(join(dir, 'package.json'))) dirs.push(dir);
  }
  return dirs;
}
