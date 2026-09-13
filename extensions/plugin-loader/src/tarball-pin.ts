// ---------------------------------------------------------------------------
// Tarball pins — what `plugins.lock`'s `integrity` pins, and the one install
// sequence that checks it (FU-1)
// ---------------------------------------------------------------------------
//
// A pin is npm's SRI for the published `package@version` tarball — the same
// value npm records as `dist.integrity` and checks a download against (verified
// on npm 11.12.1: `sha512` of the `npm pack` output equals `npm view … dist.integrity`).
// Both halves live here so the value written and the value checked cannot drift:
//
//   * `fetchTarballIntegrity` — computing a pin without installing. The web
//     install surface reaches it through `pinPluginToPersonality`
//     (`install-record.ts`).
//   * `installPackedTarball` — the one install sequence. The tarball is fetched
//     with `npm pack` into an `os.tmpdir()` scratch directory, hashed, and
//     REFUSED on mismatch before `npm install` runs; on a match, the verified
//     file itself is installed with `--ignore-scripts`, so the bytes checked are
//     the bytes installed, and the SRI returned is the pin to write.
//     `ethos plugin install` (`installScannedPlugin`) holds it to the bytes the
//     safety scan read; `installPinnedTarball` holds it to a `plugins.lock` entry
//     for `PluginLoader.installFromLockEntry`.
//
// Raw `node:fs` here is the scratch directory and nothing else: `npm pack`
// writes a FILE, and the path is under `os.tmpdir()`, never `~/.ethos/`
// (AGENTS.md, Storage exceptions). The plugins prefix's own package.json and
// package-lock.json are under `~/.ethos/` and go through the injected Storage
// (`recordRegistrySpec`).
//
// Known limits, stated rather than hidden:
//   * The pin covers the plugin's own tarball, not its dependencies — npm
//     resolves those from the registry as usual.
//   * A from-scratch `npm install` of the prefix (`recordRegistrySpec`) fetches
//     from whatever registry npm is configured with, not `entry.registry`.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import {
  computeIntegrity,
  DEFAULT_REGISTRY,
  isExactVersion,
  isValidNpmPackageName,
  type PluginLockEntry,
} from './lockfile';

/** Runs npm with an argv array. Injected by tests; production uses `execNpm`. */
export type NpmRunner = (args: string[]) => Promise<void>;

const NPM_TIMEOUT_MS = 60_000;

/** npm through `execFile` with an argv array — no shell, nothing to escape. */
export const execNpm: NpmRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('npm', args, { timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

/** How a `plugins.lock` pin is named in `PluginIntegrityError`'s message. */
const PINNED_IN_LOCKFILE = 'pinned in plugins.lock';

/** Thrown when a fetched tarball's SRI differs from the expected one. Nothing was installed. */
export class PluginIntegrityError extends Error {
  readonly expected: string;
  readonly actual: string;

  /** `expectedFrom` finishes "does not match the <expected> …" — where the expected SRI came from. */
  constructor(spec: string, expected: string, actual: string, expectedFrom = PINNED_IN_LOCKFILE) {
    super(
      `Refusing to install ${spec}: the npm tarball's integrity ${actual} does not match the ${expected} ${expectedFrom}. A published npm version cannot change, so either the registry served different bytes or the expected digest does not describe this published version. Nothing was installed.`,
    );
    this.name = 'PluginIntegrityError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** True when the entry pins a tarball; false for a legacy package.json digest. */
export function isTarballPin(entry: PluginLockEntry): boolean {
  return entry.integrityOf === 'tarball';
}

/**
 * `npm pack <pkg>@<version>` into a fresh `os.tmpdir()` scratch directory, hand
 * the tarball path to `use`, and remove the directory whatever happens.
 */
async function withPackedTarball<T>(
  pkg: string,
  version: string,
  registry: string,
  runNpm: NpmRunner,
  use: (tarballPath: string) => Promise<T>,
): Promise<T> {
  // The spec becomes an npm argv element. `readLockfile` already refused
  // anything else; the install-record path reads these from package.json.
  if (!isValidNpmPackageName(pkg) || !isExactVersion(version)) {
    throw new Error(
      `Refusing to fetch "${pkg}@${version}": not a registry package name with an exact version`,
    );
  }
  const spec = `${pkg}@${version}`;
  const scratch = await mkdtemp(join(tmpdir(), 'ethos-plugin-pack-'));
  try {
    const args = ['pack', spec, '--pack-destination', scratch, '--ignore-scripts'];
    if (registry !== DEFAULT_REGISTRY) args.push('--registry', registry);
    await runNpm(args);
    const tarballs = (await readdir(scratch)).filter((name) => name.endsWith('.tgz'));
    const [tarball] = tarballs;
    if (tarballs.length !== 1 || tarball === undefined) {
      throw new Error(`npm pack ${spec} produced ${tarballs.length} tarballs, expected exactly 1`);
    }
    return await use(join(scratch, tarball));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface FetchTarballIntegrityInput {
  package: string;
  version: string;
  registry?: string;
  runNpm?: NpmRunner;
}

/** npm's SRI (`sha512-…`) for the published `package@version` tarball. */
export async function fetchTarballIntegrity(input: FetchTarballIntegrityInput): Promise<string> {
  return withPackedTarball(
    input.package,
    input.version,
    input.registry ?? DEFAULT_REGISTRY,
    input.runNpm ?? execNpm,
    computeIntegrity,
  );
}

export interface InstallPackedTarballInput {
  package: string;
  version: string;
  registry?: string;
  /** The npm prefix to install into — `<dataDir>/plugins`. */
  pluginsDir: string;
  /** Rewrites the prefix's package.json and package-lock.json after the install. */
  storage: Storage;
  /**
   * The SRI the packed tarball must match, and where it came from (finishes
   * the refusal's "does not match the <integrity> …"). `null` installs
   * UNVERIFIED — only `installPinnedTarball`'s legacy path passes it, after
   * warning. Required rather than optional so no caller skips the check by
   * forgetting it.
   */
  expected: { integrity: string; from: string } | null;
  runNpm?: NpmRunner;
}

/**
 * Pack `package@version`, check its SRI against `expected` — throwing
 * `PluginIntegrityError` before `npm install` is invoked on a mismatch — then
 * install that same file with `--ignore-scripts` and make the prefix's record
 * of it resolvable once the scratch file is gone (`recordRegistrySpec`).
 * Returns the SRI of the installed tarball: the value to pin. A pack failure
 * throws with nothing installed.
 */
export async function installPackedTarball(
  input: InstallPackedTarballInput,
): Promise<{ integrity: string }> {
  const registry = input.registry ?? DEFAULT_REGISTRY;
  const runNpm = input.runNpm ?? execNpm;
  const { expected, pluginsDir } = input;

  const integrity = await withPackedTarball(
    input.package,
    input.version,
    registry,
    runNpm,
    async (tgz) => {
      const actual = await computeIntegrity(tgz);
      if (expected !== null && actual !== expected.integrity) {
        throw new PluginIntegrityError(
          `${input.package}@${input.version}`,
          expected.integrity,
          actual,
          expected.from,
        );
      }
      const args = ['install', '--prefix', pluginsDir, '--ignore-scripts', '--no-audit'];
      // The tarball is local; the registry still serves its dependencies.
      if (registry !== DEFAULT_REGISTRY) args.push('--registry', registry);
      args.push(tgz);
      await runNpm(args);
      return actual;
    },
  );
  await recordRegistrySpec(input.storage, pluginsDir, input.package, input.version);
  return { integrity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** npm's own formatting for package.json and package-lock.json. */
function npmJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Point the prefix's record of a tarball-installed plugin back at the registry.
 *
 * `npm install <tgz>` saves `"<pkg>": "file:<scratch>/<pkg>.tgz"` into the
 * prefix's package.json and `resolved: "file:…"` into its package-lock.json,
 * naming a file `withPackedTarball` has just deleted. Verified on npm 11.12.1:
 * with that record, `npm install` in a prefix with no node_modules and an empty
 * cache fails ENOENT, and rewriting package.json alone does not help — npm keeps
 * honouring the lock's `file:` resolution while its version satisfies the spec.
 *
 * So: the package.json spec (and the lock's root copy of it) becomes the exact
 * version, and the lock entry's `file:` `resolved` is removed, keeping its
 * `integrity` — npm's sha512 of the very tarball that was just verified. npm
 * versions are immutable, so the exact version names the same bytes; and with
 * no `resolved`, npm re-resolves `<pkg>@<version>` from its registry and refuses
 * a download whose digest differs from that `integrity` (EINTEGRITY). Verified
 * on npm 11.12.1: a later `npm install` in the prefix keeps the plugin and does
 * not restore the `file:` path, a from-scratch rebuild re-fetches and installs
 * it, a tampered `integrity` is refused, and a later `npm install <other.tgz>`
 * leaves this entry alone.
 *
 * Rejected alternatives: `--no-save` (the next `npm install --prefix` prunes the
 * unsaved plugin); writing a registry tarball URL into `resolved` (that URL
 * layout is a registry convention, not something the pin records); keeping
 * verified tarballs under the prefix (a store that only grows).
 *
 * `node_modules/.package-lock.json` still names the scratch file. npm treats it
 * as a description of the tree on disk and did not copy it back into
 * package-lock.json in any of the runs above, so it is left to npm.
 */
async function recordRegistrySpec(
  storage: Storage,
  pluginsDir: string,
  pkg: string,
  version: string,
): Promise<void> {
  const manifestPath = join(pluginsDir, 'package.json');
  const manifestSrc = await storage.read(manifestPath);
  const manifest: unknown = manifestSrc === null ? null : JSON.parse(manifestSrc);
  const deps = isRecord(manifest) ? manifest.dependencies : undefined;
  if (!isRecord(manifest) || !isRecord(deps) || typeof deps[pkg] !== 'string') {
    throw new Error(
      `npm installed the verified tarball of ${pkg}@${version} but ${manifestPath} does not record ${pkg}; a rebuild of ${pluginsDir} would not reinstall it`,
    );
  }
  deps[pkg] = version;
  await storage.writeAtomic(manifestPath, npmJson(manifest));

  // Absent under `package-lock=false`; then package.json is the whole record.
  const lockPath = join(pluginsDir, 'package-lock.json');
  const lockSrc = await storage.read(lockPath);
  if (lockSrc === null) return;
  const lock: unknown = JSON.parse(lockSrc);
  const packages = isRecord(lock) ? lock.packages : undefined;
  if (!isRecord(packages)) return;
  const root = packages[''];
  if (isRecord(root) && isRecord(root.dependencies) && pkg in root.dependencies) {
    root.dependencies[pkg] = version;
  }
  const installed = packages[`node_modules/${pkg}`];
  if (
    isRecord(installed) &&
    typeof installed.resolved === 'string' &&
    installed.resolved.startsWith('file:')
  ) {
    delete installed.resolved;
  }
  await storage.writeAtomic(lockPath, npmJson(lock));
}

export interface InstallPinnedTarballInput {
  /** The id the entry is keyed under in `plugins.lock`. */
  pluginId: string;
  entry: PluginLockEntry;
  /** The personality whose `plugins.lock` holds the entry — named in the re-pin command. */
  personalityId: string;
  /** The npm prefix to install into — `<dataDir>/plugins`. */
  pluginsDir: string;
  /** Rewrites the prefix's package.json after the install (`installPackedTarball`). */
  storage: Storage;
  runNpm?: NpmRunner;
  /** Receives the legacy-pin warning. */
  warn: (message: string) => void;
}

/** The warning a legacy (package.json-digest) entry produces, verbatim. */
export function legacyPinWarning(pluginId: string, spec: string, personalityId: string): string {
  return `plugins.lock entry "${pluginId}" (${spec}) pins a package.json digest, written before plugin pins covered the package tarball; it cannot verify the plugin's code, so ${spec} is being installed UNVERIFIED. Re-pin it with: ethos plugin install ${spec} --personality ${personalityId}`;
}

/**
 * Install a `plugins.lock` entry from its verified tarball. Throws
 * `PluginIntegrityError` — before `npm install` is invoked — when a tarball pin
 * does not match. A legacy entry is warned about and installed unverified: it
 * pinned nothing yesterday either, and refusing it would break a personality
 * bundle that installed then. Returns whether the bytes were verified.
 */
export async function installPinnedTarball(
  input: InstallPinnedTarballInput,
): Promise<{ verified: boolean }> {
  const { entry } = input;
  const verified = isTarballPin(entry);
  if (!verified) {
    input.warn(
      legacyPinWarning(input.pluginId, `${entry.package}@${entry.version}`, input.personalityId),
    );
  }
  await installPackedTarball({
    package: entry.package,
    version: entry.version,
    registry: entry.registry,
    pluginsDir: input.pluginsDir,
    storage: input.storage,
    expected: verified ? { integrity: entry.integrity, from: PINNED_IN_LOCKFILE } : null,
    runNpm: input.runNpm,
  });
  return { verified };
}
