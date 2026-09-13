// ---------------------------------------------------------------------------
// Install undo — the one routine that puts a plugins folder back after an
// install attempt failed part-way
// ---------------------------------------------------------------------------
//
// Two surfaces install a plugin (`install-record.ts` names them). Both leave
// three records that can outlive a failure: the package in
// `<pluginsDir>/node_modules`, its capability grant in `grants.json`, and a
// personality's `plugins.lock` pin. `undoPluginInstall` is the single owner of
// putting all three back, and `describeUndoneInstall` is the single owner of
// saying what the undo actually reached. Neither surface undoes anything on its
// own — a second copy of this is how one surface ends up restoring the grant
// and the other not.
//
// Why a package must not be left behind ungranted: the loader refuses only a
// REVOKED grant (`PluginLoader.revokedGrantId`, `index.ts`), not a missing one,
// so an ungranted package in `node_modules` loads on the next start.
//
// No raw `node:fs`: every read goes through the injected Storage, and npm runs
// through the injected `NpmRunner` (`tarball-pin.ts`).
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Storage } from '@ethosagent/types';
import { type PluginGrant, restoreGrant } from './grants';
import {
  isExactVersion,
  isValidPluginId,
  type PluginLockEntry,
  type PluginLockfile,
  readLockfile,
  writeLockfile,
} from './lockfile';
import {
  installPinnedTarball,
  isTarballPin,
  type NpmRunner,
  PluginIntegrityError,
} from './tarball-pin';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The folder npm installs `name` into under a plugins prefix. */
export function installedPackageDir(pluginsDir: string, name: string): string {
  return join(pluginsDir, 'node_modules', name);
}

/**
 * What `node_modules/<name>` holds: null when nothing is there, otherwise the
 * exact `name`/`version` its package.json names (null for either it does not
 * name readably).
 */
async function readInstalledCopy(
  storage: Storage,
  pluginsDir: string,
  name: string,
): Promise<{ name: string | null; version: string | null } | null> {
  const pkgDir = installedPackageDir(pluginsDir, name);
  if (!(await storage.exists(pkgDir))) return null;
  let parsed: unknown;
  try {
    const src = await storage.read(join(pkgDir, 'package.json'));
    parsed = src === null ? undefined : JSON.parse(src);
  } catch {
    parsed = undefined;
  }
  const foundName = isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : null;
  const foundVersion =
    isRecord(parsed) && typeof parsed.version === 'string' && isExactVersion(parsed.version)
      ? parsed.version
      : null;
  return { name: foundName, version: foundVersion };
}

/** A `plugins.lock` tarball pin that can reinstall a previous copy, verified. */
export interface RestorePin {
  personalityId: string;
  pluginId: string;
  entry: PluginLockEntry;
}

/** A copy of the plugin that was in the plugins folder before this install began. */
export interface PreviousPluginCopy {
  /** The exact version its package.json named, or null when it named none this could read. */
  version: string | null;
  /** A `plugins.lock` tarball pin for that exact version — what can put it back verified. */
  pin: RestorePin | null;
}

export interface FindPreviousCopyInput {
  storage: Storage;
  /** The npm prefix — `<dataDir>/plugins`. */
  pluginsDir: string;
  /** `<dataDir>/personalities`, searched for a pin. */
  personalitiesDir: string;
  /** The npm package name about to be installed. */
  name: string;
  /** Searched first when given. */
  preferredPersonality?: string;
}

/**
 * What `node_modules/<name>` holds before `npm install` runs — read then,
 * because the install replaces it. Returns null when nothing is there.
 *
 * The pin is looked for in every personality's `plugins.lock`,
 * `preferredPersonality` first: a tarball pin names the immutable published
 * bytes of `name@version`, so any personality's pin for that exact version
 * verifies the same copy. Only tarball pins count (`isTarballPin`) — a legacy
 * package.json-digest pin verifies none of the code, and restoring through it
 * would install unverified. A lockfile that does not parse is skipped: it pins
 * nothing this can trust.
 */
export async function findPreviousCopy(
  input: FindPreviousCopyInput,
): Promise<PreviousPluginCopy | null> {
  const { storage, pluginsDir, personalitiesDir, name, preferredPersonality } = input;
  const installed = await readInstalledCopy(storage, pluginsDir, name);
  if (installed === null) return null;
  const { version } = installed;
  if (version === null) return { version, pin: null };

  const ids = (await storage.list(personalitiesDir)).filter(isValidPluginId).sort();
  const ordered =
    preferredPersonality !== undefined && ids.includes(preferredPersonality)
      ? [preferredPersonality, ...ids.filter((id) => id !== preferredPersonality)]
      : ids;
  for (const personalityId of ordered) {
    let lockfile: PluginLockfile;
    try {
      lockfile = await readLockfile(storage, join(personalitiesDir, personalityId));
    } catch {
      continue;
    }
    for (const [pluginId, entry] of Object.entries(lockfile)) {
      if (entry.package === name && entry.version === version && isTarballPin(entry)) {
        return { version, pin: { personalityId, pluginId, entry } };
      }
    }
  }
  return { version, pin: null };
}

/** The grant an install attempt recorded, and what it replaced. */
export interface GrantToRestore {
  id: string;
  recorded: PluginGrant;
  /** `readGrants(…)[id]` before the attempt recorded `recorded`, or null. */
  previous: PluginGrant | null;
}

/** The `plugins.lock` entry an install attempt set out to write, and what it replaced. */
export interface PinToRestore {
  personalityId: string;
  personalityDir: string;
  pluginId: string;
  /** `pluginLockEntryFor(draft, integrity)` — the entry the attempt was writing. */
  written: PluginLockEntry;
  /** `readLockfile(…)[pluginId]` before the attempt, or null. */
  previous: PluginLockEntry | null;
}

/**
 * How far the attempt got before it failed — it decides what is on disk:
 *   - `before-npm-install`: pack, digest check or anything before `npm install` ran.
 *   - `npm-install-failed`: `npm install` itself exited non-zero.
 *   - `after-npm-install`: `npm install` succeeded and a later step failed.
 */
export type InstallStage = 'before-npm-install' | 'npm-install-failed' | 'after-npm-install';

export interface UndoPluginInstallInput {
  storage: Storage;
  pluginsDir: string;
  /** The package npm was asked to install — never a name a refused package.json claims. */
  name: string;
  /** `findPreviousCopy`, read before `npm install` ran. */
  previous: PreviousPluginCopy | null;
  runNpm: NpmRunner;
  /** One failure, as a message quotes it. Defaults to `describeInstallFailure`. */
  describeFailure?: (err: unknown) => string;
  /** Omitted when the attempt recorded no grant. */
  grant?: GrantToRestore;
  /** Omitted when the attempt had not started writing a pin. */
  pin?: PinToRestore;
}

/** Where `node_modules/<name>` was left — each state checked, not assumed. */
export type PackageUndoOutcome =
  /** `npm install` never ran, or failed leaving no package folder. */
  | { kind: 'not-installed' }
  /** `npm install` failed and the folder still names the previous copy's version. */
  | { kind: 'previous-intact' }
  /** Nothing was installed before this attempt, and nothing is now. */
  | { kind: 'removed' }
  /** The uninstall failed: the package this attempt installed is still on disk. */
  | { kind: 'left-on-disk'; failure: string }
  /** The previous copy was reinstalled from its verified pin and is on disk again. */
  | { kind: 'restored'; pin: RestorePin }
  /** The previous copy is gone and nothing is on disk: no verified pin, or reinstalling from it failed. */
  | { kind: 'previous-removed'; pin: RestorePin | null; restoreFailure: string | null }
  /** Reinstalling from the pin failed and what it left could not be removed. */
  | {
      kind: 'restore-left-on-disk';
      pin: RestorePin;
      restoreFailure: string;
      cleanupFailure: string;
    };

/** Where a grant or pin record was left. */
export type RecordUndoOutcome =
  /** The attempt wrote no such record. */
  | { kind: 'not-written' }
  /** The record from before the attempt is back, exactly as it was read. */
  | { kind: 'restored' }
  /** There was no record before the attempt; the attempt's record was deleted. */
  | { kind: 'removed' }
  /** The attempt's record never landed; the file still holds the pre-attempt record. */
  | { kind: 'unchanged' }
  /** Grant only: kept, because the package it describes is still on disk (`left-on-disk`). */
  | { kind: 'kept' }
  /** Something else rewrote the record during the attempt; left as it now is. */
  | { kind: 'changed-since' }
  /** Putting it back failed; the attempt's record is still there. */
  | { kind: 'failed'; failure: string };

export interface InstallUndoOutcome {
  package: PackageUndoOutcome;
  grant: RecordUndoOutcome;
  pin: RecordUndoOutcome;
}

/** One failure's message, as an undo message quotes it in parentheses. */
export function describeInstallFailure(err: unknown): string {
  if (err instanceof PluginIntegrityError) {
    return `the tarball's SRI ${err.actual} does not match the pinned ${err.expected}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Undo an install attempt that failed at `stage` — the one routine both
 * `ethos plugin install` (`installScannedPlugin`, apps/ethos/src/commands/plugin.ts)
 * and `PluginsService.install` (apps/web-api/src/services/plugins.service.ts) call.
 *
 * 1. The package. Before `npm install`, nothing to do. After a failed
 *    `npm install`, the folder is read: absent, or still naming the previous
 *    copy's version, it is left alone; anything else is treated as installed.
 *    After a successful one: uninstall and confirm the folder is gone. If a
 *    copy was there before, `npm install` replaced it, so the uninstall removed
 *    it too — with a verified pin it is reinstalled from that pin
 *    (`installPinnedTarball`: packs, refuses a tarball whose SRI differs from
 *    the pin before `npm install`, installs with `--ignore-scripts`) and the
 *    package.json on disk is confirmed to name the pinned version; without one
 *    nothing is reinstalled, since a guess at which bytes were there would be
 *    unverified. A failed reinstall that left files is uninstalled too.
 * 2. The grant (`restoreGrant`, grants.ts) — unless the uninstall failed: then
 *    the package this attempt installed is on disk, and its grant stays with it
 *    (`kept`), so there is never code on disk from this attempt without the
 *    consent record that describes it.
 * 3. The pin: the `plugins.lock` entry goes back to what it was, when the entry
 *    on disk is still the one the attempt wrote. `pinPluginToPersonality`
 *    writes `plugins.lock` before `config.yaml`, so a failed `config.yaml` write
 *    leaves a written entry behind; the `config.yaml` line is written last and
 *    a failure there leaves it unchanged.
 *
 * Never throws: a step that fails is reported in the outcome.
 */
export async function undoPluginInstall(
  input: UndoPluginInstallInput & { stage: InstallStage },
): Promise<InstallUndoOutcome> {
  const describe = input.describeFailure ?? describeInstallFailure;
  const { storage, pluginsDir, grant: grantRecord, pin: pinRecord } = input;
  const pkg = await undoPackage(input, describe);
  const grant: RecordUndoOutcome =
    grantRecord === undefined
      ? { kind: 'not-written' }
      : pkg.kind === 'left-on-disk'
        ? { kind: 'kept' }
        : await attempt(describe, () => restoreGrant(storage, pluginsDir, grantRecord));
  const pin: RecordUndoOutcome =
    pinRecord === undefined
      ? { kind: 'not-written' }
      : await attempt(describe, () => restoreLockEntry(storage, pinRecord));
  return { package: pkg, grant, pin };
}

async function attempt(
  describe: (err: unknown) => string,
  run: () => Promise<'restored' | 'removed' | 'unchanged' | 'changed-since'>,
): Promise<RecordUndoOutcome> {
  try {
    return { kind: await run() };
  } catch (err) {
    return { kind: 'failed', failure: describe(err) };
  }
}

/** A lock entry as it round-trips through `plugins.lock`. */
function asStored(entry: PluginLockEntry | null | undefined): unknown {
  return entry ? JSON.parse(JSON.stringify(entry)) : null;
}

/** `restoreGrant`'s rule, for one `plugins.lock` entry. */
async function restoreLockEntry(
  storage: Storage,
  pin: PinToRestore,
): Promise<'restored' | 'removed' | 'unchanged' | 'changed-since'> {
  const lockfile = await readLockfile(storage, pin.personalityDir);
  const current = asStored(lockfile[pin.pluginId]);
  if (isDeepStrictEqual(current, asStored(pin.previous))) return 'unchanged';
  if (!isDeepStrictEqual(current, asStored(pin.written))) return 'changed-since';
  if (pin.previous === null) {
    delete lockfile[pin.pluginId];
  } else {
    lockfile[pin.pluginId] = pin.previous;
  }
  await writeLockfile(storage, pin.personalityDir, lockfile);
  return pin.previous === null ? 'removed' : 'restored';
}

async function undoPackage(
  input: UndoPluginInstallInput & { stage: InstallStage },
  describe: (err: unknown) => string,
): Promise<PackageUndoOutcome> {
  const { storage, pluginsDir, name, previous, stage } = input;
  if (stage === 'before-npm-install') return { kind: 'not-installed' };
  if (stage === 'npm-install-failed') {
    const onDisk = await readInstalledCopy(storage, pluginsDir, name);
    if (onDisk === null) return { kind: 'not-installed' };
    if (previous && previous.version !== null && onDisk.version === previous.version) {
      return { kind: 'previous-intact' };
    }
  }
  const failure = await rollBack(input, describe);
  if (failure !== null) return { kind: 'left-on-disk', failure };
  if (previous === null) return { kind: 'removed' };
  const { pin } = previous;
  if (pin === null) return { kind: 'previous-removed', pin, restoreFailure: null };

  const restoreFailure = await restoreFromPin(input, pin, describe);
  if (restoreFailure === null) return { kind: 'restored', pin };
  if (!(await storage.exists(installedPackageDir(pluginsDir, name)))) {
    return { kind: 'previous-removed', pin, restoreFailure };
  }
  const cleanupFailure = await rollBack(input, describe);
  if (cleanupFailure === null) return { kind: 'previous-removed', pin, restoreFailure };
  return { kind: 'restore-left-on-disk', pin, restoreFailure, cleanupFailure };
}

/** `npm uninstall` `name`. Returns null only when `node_modules/<name>` is gone afterwards; otherwise why it is not. */
async function rollBack(
  input: UndoPluginInstallInput,
  describe: (err: unknown) => string,
): Promise<string | null> {
  const { storage, pluginsDir, name } = input;
  const pkgDir = installedPackageDir(pluginsDir, name);
  try {
    await input.runNpm(['uninstall', '--prefix', pluginsDir, name]);
  } catch (err) {
    return `npm uninstall failed: ${describe(err)}`;
  }
  if (await storage.exists(pkgDir)) {
    return `npm uninstall exited successfully but ${pkgDir} is still there`;
  }
  return null;
}

/** Reinstall a previous copy from its tarball pin. Returns null only when the package.json on disk then names the pinned package and version. */
async function restoreFromPin(
  input: UndoPluginInstallInput,
  pin: RestorePin,
  describe: (err: unknown) => string,
): Promise<string | null> {
  const { storage, pluginsDir, name } = input;
  try {
    await installPinnedTarball({
      pluginId: pin.pluginId,
      entry: pin.entry,
      personalityId: pin.personalityId,
      pluginsDir,
      storage,
      runNpm: input.runNpm,
      // `findPreviousCopy` returns tarball pins only, so the legacy-pin warning cannot fire.
      warn: () => {},
    });
  } catch (err) {
    return describe(err);
  }
  const onDisk = await readInstalledCopy(storage, pluginsDir, name);
  if (onDisk?.name !== pin.entry.package || onDisk.version !== pin.entry.version) {
    const pkgJsonPath = join(installedPackageDir(pluginsDir, name), 'package.json');
    return `the reinstalled ${pkgJsonPath} does not name ${pin.entry.package}@${pin.entry.version}`;
  }
  return null;
}

export interface DescribeUndoneInstallInput {
  undo: UndoPluginInstallInput;
  outcome: InstallUndoOutcome;
  /** What went wrong, as a full sentence. */
  found: string;
  /** What to do about `found`. */
  action: string;
  /** Finishes "Remove it before …" — e.g. "this server restarts". */
  restartsWhen: string;
}

/**
 * The message for an undone install: `found`, then the end state
 * `undoPluginInstall` confirmed — restored, removed with the command to
 * reinstall, or left on disk with the command to remove it — and never a state
 * it did not reach. When the attempt wrote no grant and no pin, the package
 * sentence says so itself ("nothing was left … granted or pinned"); otherwise
 * each record's end state gets its own sentence.
 */
export function describeUndoneInstall(input: DescribeUndoneInstallInput): {
  cause: string;
  action: string;
} {
  const { undo, outcome, found, restartsWhen } = input;
  const { pluginsDir, name, previous } = undo;
  const uninstall = `npm uninstall --prefix ${pluginsDir} ${name}`;
  const pkgDir = installedPackageDir(pluginsDir, name);
  const previousSpec = previous?.version ? `${name}@${previous.version}` : name;
  const previousCopy = previous?.version
    ? `the copy installed before this attempt, ${previousSpec}`
    : `the copy of ${name} installed before this attempt`;
  const reinstall = `ethos plugin install ${previousSpec}`;
  const rolledBack = `The install was rolled back (${uninstall})`;
  const pinned = (pin: RestorePin) =>
    `the tarball pinned in personality ${pin.personalityId}'s plugins.lock`;
  const bare = outcome.grant.kind === 'not-written' && outcome.pin.kind === 'not-written';
  const records = recordSentences(undo, outcome);
  const recordAction = recordActions(undo, outcome);
  const join2 = (...parts: string[]) => parts.filter((p) => p !== '').join(' ');

  const pkg = outcome.package;
  switch (pkg.kind) {
    case 'not-installed':
      return {
        cause: bare
          ? `${found} Nothing was installed, granted or pinned.`
          : join2(found, 'Nothing was installed.', records),
        action: join2(input.action, recordAction),
      };
    case 'previous-intact': {
      const intact = `${pkgDir} still names ${previousSpec}, installed before this attempt.`;
      return {
        cause: bare
          ? `${found} ${intact} Nothing was granted or pinned.`
          : join2(found, intact, records),
        action: join2(input.action, recordAction),
      };
    }
    case 'removed':
      return {
        cause: bare
          ? `${found} ${rolledBack}: nothing was left installed, granted or pinned.`
          : join2(found, `${rolledBack}: nothing from this attempt was left installed.`, records),
        action: join2(input.action, recordAction),
      };
    case 'left-on-disk': {
      const replaced = previous ? ` It replaced ${previousCopy}.` : '';
      return {
        cause: bare
          ? `${found} This attempt recorded no capability grant or plugins.lock pin, but rolling the install back failed (${pkg.failure}), so the package was left on disk and will load on the next start.${replaced}`
          : join2(
              found,
              `Rolling the install back failed (${pkg.failure}), so the package was left on disk and will load on the next start.${replaced}`,
              records,
            ),
        action: join2(`Remove it before ${restartsWhen}, with: ${uninstall}`, recordAction),
      };
    }
    case 'restored': {
      const back = `${rolledBack}, and ${previousCopy}, which npm replaced during this attempt, was reinstalled from ${pinned(pkg.pin)} after its SRI matched the pin: ${previousSpec} is installed again`;
      return {
        cause: bare
          ? `${found} ${back}, and nothing from this attempt was left installed, granted or pinned.`
          : join2(found, `${back}, and nothing from this attempt was left installed.`, records),
        action: join2(input.action, recordAction),
      };
    }
    case 'previous-removed': {
      const why =
        pkg.pin === null
          ? 'no readable plugins.lock entry pins its tarball, so it was not reinstalled unverified'
          : `reinstalling it from ${pinned(pkg.pin)} failed (${pkg.restoreFailure})`;
      const gone = `${rolledBack}, which also removed ${previousCopy}: npm replaced it during this attempt, and ${why}. No copy of ${name} is installed now`;
      return {
        cause: bare
          ? `${found} ${gone}, and nothing from this attempt was left granted or pinned.`
          : join2(found, `${gone}.`, records),
        action: join2(
          input.action,
          `To reinstall ${previousSpec}, run: ${reinstall}`,
          recordAction,
        ),
      };
    }
    case 'restore-left-on-disk':
      return {
        cause: join2(
          found,
          `${rolledBack}, which also removed ${previousCopy}: npm replaced it during this attempt. Reinstalling it from ${pinned(pkg.pin)} failed (${pkg.restoreFailure}), and removing what that reinstall left failed (${pkg.cleanupFailure}), so ${pkgDir} is on disk and will load on the next start.`,
          records,
        ),
        action: join2(
          `Remove it before ${restartsWhen}, with: ${uninstall} — then reinstall ${previousSpec} with: ${reinstall}`,
          recordAction,
        ),
      };
  }
}

/** One sentence per record the attempt wrote, saying where it was left. */
function recordSentences(undo: UndoPluginInstallInput, outcome: InstallUndoOutcome): string {
  const out: string[] = [];
  const { grant, pin } = undo;
  if (grant !== undefined) {
    const { id, recorded } = grant;
    const file = join(undo.pluginsDir, 'grants.json');
    switch (outcome.grant.kind) {
      case 'restored':
        out.push(
          `The capability grant recorded for ${id} before this attempt was put back as it was.`,
        );
        break;
      case 'removed':
        out.push(
          `The capability grant this attempt recorded for ${id} was removed; none was recorded before it.`,
        );
        break;
      case 'unchanged':
        out.push(`The capability grant for ${id} was not changed.`);
        break;
      case 'kept':
        out.push(
          `The capability grant this attempt recorded for ${id} (${recorded.package}@${recorded.version}) was kept, because that package is still on disk.`,
        );
        break;
      case 'changed-since':
        out.push(
          `The capability grant for ${id} in ${file} was changed by something else during this attempt, so it was left as it now is.`,
        );
        break;
      case 'failed':
        out.push(
          `Putting back the capability grant for ${id} in ${file} failed (${outcome.grant.failure}), so it still records ${recorded.package}@${recorded.version} from this attempt.`,
        );
        break;
    }
  }
  if (pin !== undefined) {
    const { personalityId, pluginId, written } = pin;
    const lock = `personality ${personalityId}'s plugins.lock`;
    switch (outcome.pin.kind) {
      case 'restored':
        out.push(`The ${pluginId} entry in ${lock} was put back as it was.`);
        break;
      case 'removed':
        out.push(`The ${pluginId} entry this attempt wrote to ${lock} was removed.`);
        break;
      case 'unchanged':
        out.push(`Personality ${personalityId}'s plugins.lock was not changed.`);
        break;
      case 'changed-since':
        out.push(
          `The ${pluginId} entry in ${lock} was changed by something else during this attempt, so it was left as it now is.`,
        );
        break;
      case 'failed':
        out.push(
          `Putting back the ${pluginId} entry in ${lock} failed (${outcome.pin.failure}), so it still pins ${written.package}@${written.version} from this attempt.`,
        );
        break;
    }
  }
  return out.join(' ');
}

/** What the operator should check when a record could not be put back. */
function recordActions(undo: UndoPluginInstallInput, outcome: InstallUndoOutcome): string {
  const out: string[] = [];
  if (outcome.grant.kind === 'failed' && undo.grant !== undefined) {
    out.push(`Check the recorded grant with: ethos plugin grants.`);
  }
  if (outcome.pin.kind === 'failed' && undo.pin !== undefined) {
    out.push(
      `Check the ${undo.pin.pluginId} entry in ${join(undo.pin.personalityDir, 'plugins.lock')}.`,
    );
  }
  return out.join(' ');
}
