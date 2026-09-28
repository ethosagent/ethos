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
// The hash covers every file under the plugin directory EXCEPT nested
// `node_modules/` and `.git/` — the same tree the safety scan reads
// (`collectFindings`). Limitation: a dependency the plugin loads from outside
// that tree (a nested `node_modules`, or a sibling package in a pnpm layout)
// can change after the grant without voiding it.
//
// Like the capability grant in ./grants.ts this is a consent record, not a
// sandbox: a trusted plugin runs in-process with full privileges.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
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
 * bytes, `node_modules/` and `.git/` skipped. Any added, removed, renamed or
 * edited file changes it.
 */
export async function hashPluginTree(storage: Storage, dir: string): Promise<string> {
  const root = resolve(dir);
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await storage.listEntries(current).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDir) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(full);
      } else {
        files.push(full);
      }
    }
  };
  await walk(root);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = await storage.readBytes(file);
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(bytes ?? new Uint8Array());
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
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
