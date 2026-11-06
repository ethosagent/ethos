// ---------------------------------------------------------------------------
// Catalog installers (plan/phases/unified-catalog.md §6.3, D9, D14, D16, D17)
// ---------------------------------------------------------------------------
//
// Every catalog install of a plugin or a skill starts here, so neither the
// web-api nor the CLI imports an extension to do it. Neither installer ever
// grants anything (D9): no personality id reaches them, no `plugins.lock` pin
// and no `plugins:` / `skills.global_ingest.allow` line is written. Pinned by
// __tests__/catalog-install.test.ts ("writes no personality pin",
// "no personality config changes").
//
// Plugins. The tarball is held to the CATALOG's sha512 (`entry.pin.integrity`),
// never to `npm view` (the injected `installPinned` is `PluginsService
// .installCatalogPin`, which passes it as `expected` to `installPackedTarball`),
// and `catalogScanGate` refuses red findings (D14) so the install is undone by
// that service's `refuseInstalled`.
//
// LIMITATION (checked 2026-11-05 against plan/completed/plugin-process-
// isolation.md and extensions/plugin-host): plugin process isolation has
// shipped and is opt-in. The grant this install records carries the entry's
// review tier as `catalogTier`, and `resolvePluginIsolation`
// (extensions/plugin-loader/src/isolation-policy.ts) forces a `community`
// catalog plugin into the plugin host child process; any other plugin runs
// where `plugins.isolation` says, and that DEFAULT is in-process. So a
// `verified` or `official` catalog plugin is third-party code that still runs
// in-process at boot, for every personality's process, whatever the grants
// (grants gate what a turn SEES), unless the operator set
// `plugins.isolation.default: host`. A hosted plugin is also not a secrets
// boundary without `plugins.host.sandbox: auto` (agent-loop.md, "Plugin host
// mode"). D19 still admits no `community` plugin entry (enforced by
// packages/catalog/src/__tests__/index.test.ts), and a red finding is refused.
//
// Skills. `withGitPinnedTree` (extensions/plugin-loader/src/git-pin.ts)
// fetches the pinned commit and refuses a tree whose digest differs. The
// SKILL.md and any source files must then scan with NO red and NO yellow
// finding (D16: discovery drops yellow, and no acknowledgement store exists).
// The tree is copied into a temp dir under the catalog-skills root and renamed
// onto `catalogSkillPath(dataDir, id)`. The skill is invisible to every
// personality until `skills.global_ingest.allow` names `catalog/<id>`
// (`filterSkill`, extensions/skills/src/ingest-filter.ts).
//
// The lock, temp and rename steps follow `atomicInstall` in
// apps/ethos/src/commands/skills.ts (D17: copied, not moved, so the working
// CLI path is untouched). Two deliberate differences: the lock is this
// package's `acquireSentinelLock` rather than a third hand-rolled `wx` lock,
// and every filesystem call goes through the injected Storage (including
// `rename`), so this file needs no raw `node:fs` carve-out.
// ---------------------------------------------------------------------------

import { basename, dirname, join } from 'node:path';
import { catalogSkillPath } from '@ethosagent/catalog';
import {
  type GitPinDeps,
  GitPinFetchError,
  GitPinInputError,
  GitPinMismatchError,
  type GitPinnedFile,
  GitPinRefusedError,
  withGitPinnedTree,
} from '@ethosagent/plugin-loader';
import { type ScanFinding, scanPluginCode, scanSkillMd } from '@ethosagent/safety-scanner';
import { isSafePathSegment } from '@ethosagent/storage-fs';
import { type CatalogEntry, EthosError, type Storage } from '@ethosagent/types';
import { acquireSentinelLock } from './backup/sentinel-lock';

export interface CatalogInstallResult {
  kind: 'plugin' | 'skill';
  id: string;
  /** The plugin id its grant is recorded under, or the skill's directory name. */
  installedAs: string;
}

/** What a plugin scan looks like to the gate (structurally `PluginsService`'s `CatalogScanSummary`). */
export interface CatalogScanSummary {
  hasRed: boolean;
  hasYellow: boolean;
  findings: ScanFinding[];
}

/**
 * Why the scan blocks a catalog plugin install, or null to let it proceed.
 * D14: RED findings refuse the install (as `ethos plugin install` does), and
 * YELLOW findings do not: they are recorded in the plugin's grant for the
 * operator, which is what the CLI and web paths already do. Pinned by
 * __tests__/catalog-install.test.ts "catalogScanGate".
 */
export function catalogScanGate(scan: CatalogScanSummary): string | null {
  if (!scan.hasRed) return null;
  const rules = [...new Set(scan.findings.filter((f) => f.severity === 'red').map((f) => f.rule))];
  return `red findings: ${rules.join(', ')}`;
}

/** `PluginsService.installCatalogPin`, injected so wiring imports no app. */
export type CatalogPluginInstaller = (
  pin: { package: string; version: string; integrity: string },
  opts: { refuseScan: (scan: CatalogScanSummary) => string | null; tier: string },
) => Promise<{ id: string }>;

export interface CatalogPluginDeps {
  installPinned: CatalogPluginInstaller;
}

export async function installCatalogPlugin(
  entry: CatalogEntry,
  deps: CatalogPluginDeps,
): Promise<CatalogInstallResult> {
  if (entry.kind !== 'plugin' || entry.pin.type !== 'npm') {
    throw unsupported(entry, 'a plugin entry with an npm pin');
  }
  const { package: pkg, version, integrity } = entry.pin;
  const { id } = await deps.installPinned(
    { package: pkg, version, integrity },
    { refuseScan: catalogScanGate, tier: entry.tier },
  );
  return { kind: 'plugin', id: entry.id, installedAs: id };
}

export interface CatalogSkillDeps {
  storage: Storage;
  /** The data dir (honours ETHOS_STATE_DIR); the skill lands under `catalogSkillPath(dataDir, id)`. */
  dataDir: string;
  /** Test seam for the git runner. */
  git?: GitPinDeps;
  /** Test seam: replaces `withGitPinnedTree`, so a test can hand `fn` a crafted manifest. */
  withTree?: typeof withGitPinnedTree;
  /** Test seam: the per-process temp suffix. */
  pid?: number;
}

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 200;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const MAX_SKILL_DEPTH = 6;
const slashes = (p: string) => p.split('\\').join('/');

function unsupported(entry: CatalogEntry, needs: string): EthosError {
  return new EthosError({
    code: 'CATALOG_INSTALL_UNSUPPORTED',
    cause: `Catalog entry '${entry.id}' (${entry.kind}, ${entry.pin.type} pin) cannot be installed this way: expected ${needs}`,
    action: `Run: ethos catalog show ${entry.id}`,
  });
}

function alreadyInstalled(id: string): EthosError {
  return new EthosError({
    code: 'CATALOG_ALREADY_INSTALLED',
    cause: `Catalog skill '${id}' is already installed`,
    action: 'Nothing to do. To reinstall it, remove its directory under catalog-skills first.',
  });
}

export interface SkillCopyFile {
  /** `/`-separated path in the pinned tree, to read from. */
  from: string;
  /** Path relative to the skill directory, `/`-separated, to write to. */
  rel: string;
  executable: boolean;
}

/**
 * Which manifest files make up the skill: the directory holding the shallowest
 * SKILL.md, and everything below it. Both sides of the prefix comparison are
 * normalised to `/`. FAILS CLOSED: no SKILL.md, a path with an empty, `.` or
 * `..` segment, a located SKILL.md that is not among the files, or zero files
 * all throw, so a manifest that does not match the prefix can never install an
 * empty or partial directory. Pinned by __tests__/catalog-install.test.ts
 * "planSkillCopy".
 */
export function planSkillCopy(
  id: string,
  manifest: readonly GitPinnedFile[],
): { files: SkillCopyFile[] } {
  const norm = manifest.map((f) => ({ ...f, norm: slashes(f.path) }));
  const skillMds = norm
    .filter((f) => f.norm === 'SKILL.md' || f.norm.endsWith('/SKILL.md'))
    .map((f) => f.norm)
    .filter((p) => p.split('/').length - 1 <= MAX_SKILL_DEPTH)
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  const located = skillMds[0];
  if (located === undefined) {
    throw new EthosError({
      code: 'CATALOG_INSTALL_UNSUPPORTED',
      cause: `The pinned tree for '${id}' has no SKILL.md`,
      action: 'Report this catalog entry; its pin does not point at a skill.',
    });
  }
  const prefix = located === 'SKILL.md' ? '' : located.slice(0, -'/SKILL.md'.length);
  const files: SkillCopyFile[] = [];
  for (const f of norm) {
    if (prefix !== '' && !f.norm.startsWith(`${prefix}/`)) continue;
    const rel = prefix === '' ? f.norm : f.norm.slice(prefix.length + 1);
    if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw pinInconsistent(id, `the manifest path "${f.path}" is not a plain relative path`);
    }
    files.push({ from: f.norm, rel, executable: f.executable });
  }
  if (files.length === 0 || !files.some((f) => f.rel === 'SKILL.md')) {
    throw pinInconsistent(id, 'the located SKILL.md is not among the files to copy');
  }
  return { files };
}

function pinInconsistent(id: string, why: string): EthosError {
  return new EthosError({
    code: 'CATALOG_PIN_MISMATCH',
    cause: `Catalog skill '${id}' could not be installed: ${why}. Nothing was installed.`,
    action: 'Report this catalog entry.',
  });
}

/**
 * Read each file of the verified manifest ONCE: scan it (SKILL.md, and JS/TS
 * source outside node_modules; D16 allows no finding of either severity), and
 * write it into `to`. The caller discards `to` on any throw. Scope limit: other
 * files (.md references, data, scripts in other languages) are digest-pinned
 * and human-reviewed, not scanned.
 */
async function scanAndCopy(
  storage: Storage,
  id: string,
  from: string,
  to: string,
  files: readonly SkillCopyFile[],
): Promise<void> {
  const findings: ScanFinding[] = [];
  const decoder = new TextDecoder();
  const madeDirs = new Set<string>();
  for (const f of files) {
    const bytes = await storage.readBytes(join(from, f.from));
    if (bytes === null) throw pinInconsistent(id, `pinned file vanished: ${f.rel}`);
    if (f.rel === 'SKILL.md') {
      findings.push(...scanSkillMd(decoder.decode(bytes), f.rel).findings);
    } else if (
      SOURCE_EXT.test(f.rel) &&
      !f.rel.endsWith('.d.ts') &&
      !f.rel.split('/').includes('node_modules')
    ) {
      findings.push(...scanPluginCode(decoder.decode(bytes)).findings);
    }
    const dest = join(to, f.rel);
    const dir = dirname(dest);
    if (!madeDirs.has(dir)) {
      await storage.mkdir(dir);
      madeDirs.add(dir);
    }
    await storage.write(dest, bytes, { mode: f.executable ? 0o755 : 0o644 });
  }
  if (findings.length > 0) {
    const rules = [...new Set(findings.map((f) => `${f.severity}:${f.rule}`))].join(', ');
    throw new EthosError({
      code: 'CATALOG_SCAN_BLOCKED',
      cause: `Catalog skill '${id}' failed the install scan (${rules}). A catalog skill must scan with no red and no yellow finding.`,
      action: 'Do not install it. Report the catalog entry.',
      details: { findings },
    });
  }
}

export async function installCatalogSkill(
  entry: CatalogEntry,
  deps: CatalogSkillDeps,
): Promise<CatalogInstallResult> {
  if (entry.kind !== 'skill' || entry.pin.type !== 'git') {
    throw unsupported(entry, 'a skill entry with a git pin');
  }
  const { storage, dataDir } = deps;
  const { id } = entry;
  if (!isSafePathSegment(id)) throw unsupported(entry, 'a plain directory name as its id');
  const pin = entry.pin;
  const target = catalogSkillPath(dataDir, id);
  const root = dirname(target);
  if (await storage.exists(target)) throw alreadyInstalled(id);

  await storage.mkdir(root);
  const lockPath = join(root, '.lock');
  const release = await acquireSentinelLock({
    lockPath,
    timeoutMs: LOCK_TIMEOUT_MS,
    retryMs: LOCK_POLL_MS,
    unreadableStaleMs: LOCK_TIMEOUT_MS,
    refusal: () =>
      `another catalog skill install is in progress (lock held: ${lockPath}). Wait for it to finish; if none is running, delete that file.`,
  });
  const tmpRoot = join(root, '.tmp');
  const tmpDir = join(tmpRoot, `${id}-${deps.pid ?? process.pid}`);
  try {
    // Re-check under the lock: a concurrent install may have just finished.
    if (await storage.exists(target)) throw alreadyInstalled(id);
    await storage.remove(tmpDir, { recursive: true }).catch(() => undefined);
    await storage.mkdir(tmpDir);
    try {
      await (deps.withTree ?? withGitPinnedTree)(
        {
          repo: pin.repo,
          commit: pin.commit,
          ...(pin.subdir !== undefined ? { subdir: pin.subdir } : {}),
          contentDigest: pin.contentDigest,
        },
        async (dir, files) => {
          const plan = planSkillCopy(id, files);
          await scanAndCopy(storage, id, dir, tmpDir, plan.files);
        },
        deps.git,
      );
    } catch (err) {
      throw translateGitError(err, id);
    }
    await storage.rename(tmpDir, target);
  } finally {
    await storage.remove(tmpDir, { recursive: true }).catch(() => undefined);
    release();
  }
  return { kind: 'skill', id, installedAs: basename(target) };
}

function translateGitError(err: unknown, id: string): unknown {
  if (err instanceof GitPinMismatchError || err instanceof GitPinFetchError) {
    return new EthosError({
      code: 'CATALOG_PIN_MISMATCH',
      cause: `Catalog skill '${id}' could not be verified: ${err.message}`,
      action: 'Retry. If the digest is refused again, do not install it, and report the entry.',
    });
  }
  if (err instanceof GitPinRefusedError) {
    return new EthosError({
      code: 'CATALOG_SCAN_BLOCKED',
      cause: `Catalog skill '${id}' was refused: ${err.message}`,
      action: 'Do not install it. Report the catalog entry.',
    });
  }
  if (err instanceof GitPinInputError) {
    return new EthosError({
      code: 'CATALOG_INSTALL_UNSUPPORTED',
      cause: `Catalog skill '${id}' has an invalid git pin: ${err.message}`,
      action: 'Report the catalog entry.',
    });
  }
  return err;
}

// ---------------------------------------------------------------------------
// Skill grants: the one place `catalog/<id>` is added to or removed from a
// personality's `skills.global_ingest.allow`. Used by `CatalogService
// .setSkillGrant` (web-api) and `ethos catalog grant` (apps/ethos), so the two
// cannot drift. Only the allow list is written; the registry's update path
// leaves every other personality key alone.
// ---------------------------------------------------------------------------

/** The grant name of a catalog skill: the scanner's `catalog` source label + the directory (= the entry id). */
export function catalogSkillGrant(id: string): string {
  return `catalog/${id}`;
}

export interface CatalogGrantDeps {
  personalities: {
    get(id: string): { builtin: boolean; allow: string[] } | undefined;
    setAllow(id: string, allow: string[]): Promise<void>;
  };
  skillInstalled(id: string): Promise<boolean>;
}

/**
 * Grant or revoke one installed catalog skill for one personality. Errors:
 * a non-skill entry INVALID_INPUT (400); an unknown personality
 * PERSONALITY_NOT_FOUND (404); a built-in PERSONALITY_READ_ONLY (403); granting
 * a skill that is not installed INVALID_INPUT (400). Revoking is always allowed,
 * so a stale grant can be cleared. Pinned by __tests__/catalog-install.test.ts
 * and apps/web-api/src/__tests__/services/catalog-install.test.ts.
 */
export async function setCatalogSkillGrant(
  entry: CatalogEntry,
  input: { personalityId: string; granted: boolean },
  deps: CatalogGrantDeps,
): Promise<{ allow: string[] }> {
  if (entry.kind !== 'skill') {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `'${entry.id}' is a ${entry.kind} entry; only skills are granted through the allow list`,
      action:
        entry.kind === 'mcp'
          ? `Attach it with: ethos personality mcp <id> --attach ${entry.id}`
          : 'Attach it on the Plugins page.',
    });
  }
  const personality = deps.personalities.get(input.personalityId);
  if (!personality) {
    throw new EthosError({
      code: 'PERSONALITY_NOT_FOUND',
      cause: `No personality '${input.personalityId}'`,
      action: 'Refresh the personality list and re-select.',
    });
  }
  if (personality.builtin) {
    throw new EthosError({
      code: 'PERSONALITY_READ_ONLY',
      cause: `'${input.personalityId}' is a built-in personality and cannot be edited`,
      action: 'Duplicate it, then grant the skill to the copy.',
    });
  }
  // Granting something that is not on disk would leave a dangling allow line.
  if (input.granted && !(await deps.skillInstalled(entry.id))) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `'${entry.id}' is not installed, so there is nothing to grant`,
      action: `Install it first: ethos catalog install ${entry.id}`,
    });
  }
  const grant = catalogSkillGrant(entry.id);
  const rest = personality.allow.filter((n) => n !== grant);
  const allow = input.granted ? [...rest, grant] : rest;
  await deps.personalities.setAllow(input.personalityId, allow);
  return { allow };
}
