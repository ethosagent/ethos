import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir } from '@ethosagent/config';
import {
  describeInstallFailure,
  describeUndoneInstall,
  draftPluginGrant,
  execNpm,
  findPreviousCopy,
  grantsPath,
  type InstallStage,
  type InstallUndoOutcome,
  installPackedTarball,
  migrateLegacyPluginCredentials,
  type NpmRunner,
  type PluginGrant,
  type PluginGrantDraft,
  PluginIntegrityError,
  type PluginLockEntry,
  pinPluginToPersonality,
  pluginCredentialPrefix,
  pluginCredentialRef,
  pluginLockEntryFor,
  readGrants,
  readLockfile,
  readPluginPermissions,
  recordGrant,
  revokeGrant,
  type UndoPluginInstallInput,
  undoPluginInstall,
} from '@ethosagent/plugin-loader';
import { FileSecretsResolver } from '@ethosagent/storage-fs';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import {
  canInstall,
  type PluginScanPermissions,
  type ScanFinding,
  scanPluginCode,
} from '@ethosagent/wiring/security-kernel';
import { writeJson } from '../json-output';
import { getStorage, recordInstallScan } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function pluginsDir(): string {
  return join(homedir(), '.ethos', 'plugins');
}

export async function runPlugin(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'install': {
      const yesFlag = args.includes('--yes');
      const rest = args.filter((a) => a !== '--yes');
      const pkg = rest[1];
      if (!pkg) {
        console.log('Usage: ethos plugin install <package> [--personality <id>] [--yes]');
        console.log('  --yes  record the capability grant without an interactive prompt');
        process.exit(1);
      }
      const pFlagIdx = rest.indexOf('--personality');
      const personalityId = pFlagIdx >= 0 ? rest[pFlagIdx + 1] : undefined;
      if (pFlagIdx >= 0 && !personalityId) {
        console.log('Usage: ethos plugin install <package> [--personality <id>] [--yes]');
        process.exit(1);
      }
      try {
        await installPlugin(pkg, personalityId, yesFlag);
      } catch (err) {
        if (err instanceof EthosError) {
          console.error(`${c.red}${err.cause}${c.reset}\n${c.dim}→ ${err.action}${c.reset}`);
        } else {
          console.error(
            `${c.red}Install failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
          );
        }
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const pkg = args[1];
      if (!pkg) {
        console.log('Usage: ethos plugin remove <package>');
        process.exit(1);
      }
      const dir = pluginsDir();
      const result = spawnSync('npm', ['uninstall', '--prefix', dir, pkg], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`${c.red}Remove failed.${c.reset}`);
        process.exit(result.status ?? 1);
      }
      // Removing the package does not withdraw consent: the grant still stands,
      // so a personality lockfile can auto-install it again. Say so.
      console.log(`\n${c.green}✓ Removed.${c.reset}`);
      console.log(
        `${c.dim}The capability grant stands. Withdraw it with: ${c.reset}ethos plugin revoke <pluginId>`,
      );
      break;
    }

    case 'list': {
      await listPlugins(args);
      break;
    }

    case 'credentials': {
      await runCredentials(args.slice(1));
      break;
    }

    case 'grants': {
      await listGrants(args.includes('--json'));
      break;
    }

    case 'revoke': {
      const pluginId = args[1];
      if (!pluginId) {
        console.log('Usage: ethos plugin revoke <pluginId>');
        process.exit(1);
      }
      await revokePluginGrant(pluginId);
      break;
    }

    default:
      console.log(
        'Usage: ethos plugin [install <pkg> | remove <pkg> | list | grants | revoke <pluginId> | credentials <pluginId>]',
      );
  }
}

// ---------------------------------------------------------------------------
// Install: download to temp, scan, prompt, then commit
// ---------------------------------------------------------------------------

async function installPlugin(pkg: string, personalityId?: string, yesFlag = false): Promise<void> {
  const dir = pluginsDir();
  const tmpDir = join(dir, `.tmp-scan-${process.pid}`);

  console.log(
    `${c.dim}Downloading ${c.reset}${c.bold}${pkg}${c.reset}${c.dim} for safety scan...${c.reset}\n`,
  );

  // Step 1: download without running install scripts so we can scan first
  const pre = spawnSync(
    'npm',
    ['install', '--prefix', tmpDir, '--ignore-scripts', '--no-audit', pkg],
    { stdio: 'inherit' },
  );
  if (pre.status !== 0) {
    await rm(tmpDir, { recursive: true, force: true });
    console.error(`${c.red}Download failed.${c.reset}`);
    process.exit(pre.status ?? 1);
  }

  // Exact name@version resolved during the scan — used for the final install so we
  // commit exactly what was scanned rather than re-resolving the original spec (which
  // could yield a different version if a range, dist-tag, git ref, or mutable URL
  // changed between the scan and the install). The final install fetches it again,
  // so it is also held to the digest npm recorded for the scanned copy.
  let exactSpec = pkg;
  let scannedIntegrity: string | undefined;

  // Consent is taken AFTER the temp scan dir is cleaned up, so the grant draft
  // is carried out of the `try`. `blockedBy` is likewise reported after the
  // `finally` — `process.exit()` skips `finally`, which would leave the temp
  // scan tree behind.
  let blockedBy: string | undefined;
  let draft: PluginGrantDraft | undefined;

  try {
    // Step 2: locate the installed package dir from the manifest npm wrote —
    // deriving the dir from the argument string fails for tarballs, git URLs,
    // local paths, and version ranges.
    const pkgDir = await findInstalledPkgDir(tmpDir, pkg);

    // Step 3: read declared permissions from package.json (ethos.permissions)
    const permissions = readPluginPermissions(await readPackageJson(pkgDir));

    // Step 4: recursive scan
    const findings: ScanFinding[] = [];
    await walkAndScan(pkgDir, permissions, findings);
    const hasRed = findings.some((f) => f.severity === 'red');
    const hasYellow = findings.some((f) => f.severity === 'yellow');
    const scanResult = { findings, hasRed, hasYellow };

    // Step 5: read display metadata from the installed package.json
    let author = '(unsigned)';
    let networkDisplay = '(none declared)';
    let shellDisplay = '(none declared)';
    let rawMeta: unknown;
    try {
      rawMeta = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'));
      const rawAuthor = (rawMeta as Record<string, unknown>).author;
      if (typeof rawAuthor === 'string' && rawAuthor) {
        author = rawAuthor;
      } else if (typeof rawAuthor === 'object' && rawAuthor !== null) {
        const a = rawAuthor as Record<string, unknown>;
        if (typeof a.name === 'string' && a.name) author = a.name;
      }
    } catch {
      // package.json already verified to exist; malformed JSON is safe to ignore here
    }
    if (permissions.network !== undefined) {
      networkDisplay =
        permissions.network.length > 0 ? permissions.network.join(' · ') : '(any host)';
    }
    if (permissions.shell === true) {
      shellDisplay = 'yes';
    }

    const labelW = 20;
    console.log(`\n${c.bold}Install metadata — ${pkg}${c.reset}`);
    console.log(`  ${'Source'.padEnd(labelW)}${c.dim}community (npm) · ${pkg}${c.reset}`);
    console.log(`  ${'Author'.padEnd(labelW)}${author}`);
    console.log(`  ${'Network access'.padEnd(labelW)}${c.dim}${networkDisplay}${c.reset}`);
    console.log(`  ${'Shell access'.padEnd(labelW)}${c.dim}${shellDisplay}${c.reset}`);

    // Step 6: show tier badge + findings
    const tier = 'community'; // npm packages are always community
    if (hasRed || hasYellow) {
      const tierColor = c.yellow;
      console.log(`\n${c.bold}Safety scan — ${pkg}${c.reset}  ${tierColor}[${tier}]${c.reset}`);
      for (const f of findings) {
        const color = f.severity === 'red' ? c.red : c.yellow;
        const loc = f.line !== undefined ? `:${f.line}` : '';
        console.log(
          `  ${color}${f.severity === 'red' ? '✗' : '⚠'} ${f.severity}${c.reset}  ${f.rule}${loc}`,
        );
        if (f.message) console.log(`     ${c.dim}${f.message}${c.reset}`);
        if (f.excerpt) console.log(`     ${c.dim}${f.excerpt}${c.reset}`);
      }
    }

    // Step 7: red findings are a hard stop; everything else goes to consent.
    const decision = canInstall(scanResult, tier);
    recordInstallScan({ kind: 'plugin', source: pkg, tier, scan: scanResult, decision });
    if (!decision.allowed && hasRed) {
      blockedBy = decision.blockedBy ?? 'red safety finding';
    } else {
      // Read while the scan prefix still exists: the final install must match it.
      scannedIntegrity = await readScannedIntegrity(tmpDir, pkgDir, pkg);
      // The shared install-record helper keys the grant by the id the LOADER
      // resolves and pins the exact resolved version, so the final install
      // commits what was scanned.
      ({ draft, exactSpec } = draftPluginGrant({
        pkgJson: rawMeta,
        requestedSpec: pkg,
        // Verbatim, as shown above. A later reviewer needs what the operator
        // saw, not a re-scan of code that may have changed since.
        scan: { tier, findings, hasRed, hasYellow },
      }));
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  if (blockedBy !== undefined || draft === undefined || scannedIntegrity === undefined) {
    console.log(
      `\n${c.red}✗ Install blocked:${c.reset} ${blockedBy ?? 'the package could not be scanned'}`,
    );
    console.log(`${c.dim}Review the findings above or choose a different package.${c.reset}`);
    process.exit(1);
  }

  // Step 8: consent. No grant, no install — the operator is told what they are
  // taking on and agrees to it, and that agreement is written down first.
  printPluginConsequence(draft);
  const mode = resolvePluginConsent({
    pkg,
    yesFlag,
    isTTY: !!process.stdin.isTTY,
    managed: process.env.ETHOS_MANAGED === '1',
  });
  let consent: PluginGrant['consent'] = 'flag';
  if (mode === 'prompt') {
    const confirmed = await promptConfirm(
      `\n${c.bold}Install ${pkg} and record this grant? [y/N]${c.reset} `,
    );
    if (!confirmed) {
      console.log(
        `${c.dim}Install cancelled. Nothing was installed and no grant recorded.${c.reset}`,
      );
      process.exit(0);
    }
    consent = 'interactive';
  }

  // Step 9: approved — record the grant, then install what was scanned
  // (`installScannedPlugin`). It packs the exact resolved spec, refuses a
  // tarball whose SRI differs from the one npm recorded for the scanned copy,
  // and installs that verified file with --ignore-scripts: lifecycle scripts
  // (preinstall/install/postinstall) are not scanned and can execute arbitrary
  // code, so plugins must not rely on them. The personality pin is written from
  // the same SRI. Any failure after the grant is recorded is undone and reported
  // from the end state the undo confirmed (`PluginInstallUndoneError`).
  console.log(
    `\n${c.dim}Installing ${c.reset}${c.bold}${exactSpec}${c.reset}${c.dim} from its verified tarball to ${dir}...${c.reset}\n`,
  );
  let entry: PluginLockEntry | undefined;
  try {
    entry = await installScannedPlugin({
      storage: getStorage(),
      pluginsDir: dir,
      grant: { ...draft, grantedAt: new Date().toISOString(), consent },
      scannedIntegrity,
      personalitiesDir: join(ethosDir(), 'personalities'),
      personalityId,
    });
  } catch (err) {
    if (err instanceof PluginInstallUndoneError) {
      console.error(`${c.red}✗ ${err.message}${c.reset}`);
      console.error(`${c.dim}→ ${err.action}${c.reset}`);
    } else {
      // Everything `installScannedPlugin` throws once the grant is recorded is a
      // `PluginInstallUndoneError`; anything else failed before `recordGrant`
      // wrote (its `writeGrants` is a `writeAtomic`), so nothing changed.
      console.error(
        `${c.red}Install failed before anything was installed or granted:${c.reset} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(1);
  }
  console.log(
    `${c.green}✓${c.reset} Grant recorded for ${c.cyan}${draft.id}${c.reset} ${c.dim}(ethos plugin grants)${c.reset}`,
  );
  console.log(`\n${c.green}✓ Installed.${c.reset} Restart ethos to load the plugin.`);

  if (entry && personalityId) {
    console.log(
      `${c.green}✓${c.reset} Added ${c.cyan}${draft.id}${c.reset} to personality ${c.bold}${personalityId}${c.reset} ${c.dim}(pinned ${entry.package}@${entry.version} tarball ${entry.integrity.slice(0, 23)}…)${c.reset}.`,
    );
  }
}

export interface InstallScannedPluginInput {
  storage: Storage;
  /** The npm prefix — `~/.ethos/plugins`. */
  pluginsDir: string;
  /** The grant to record: the scanned draft, plus when and how consent was taken. */
  grant: PluginGrant;
  /** The SRI npm recorded for the copy the safety scan read (`readScannedIntegrity`). */
  scannedIntegrity: string;
  /** `<dataDir>/personalities` — pins `--personality` into, and is searched for a pin that can restore a replaced copy. */
  personalitiesDir: string;
  /** `--personality`; omitted, nothing is pinned. */
  personalityId?: string;
  /** Defaults to `execNpm`; tests inject a fake. */
  runNpm?: NpmRunner;
}

/**
 * The commit half of `ethos plugin install`, run once consent is taken:
 *
 *   1. Record `grant` — BEFORE any code lands on disk, so there is never code
 *      from this install without its consent record. A failure here throws
 *      with nothing changed (`writeGrants` is a `writeAtomic`).
 *   2. Pack `grant.package@grant.version`, refuse it unless its SRI is
 *      `scannedIntegrity`, install that tarball (`installPackedTarball`, which
 *      also leaves the plugins folder resolvable without the scratch file).
 *   3. With `personalityId`, pin it from the SRI just verified — no second
 *      fetch, so the pin names the bytes on disk. Returns the lock entry.
 *
 * A failure in 2 or 3 goes through `undoPluginInstall`
 * (extensions/plugin-loader/src/install-undo.ts, the routine the web install
 * also uses): the package is uninstalled and a copy it replaced reinstalled
 * from a verified pin, the grant and pin go back to what they were before, and
 * `PluginInstallUndoneError` carries the message built from the end state the
 * undo confirmed. A pin that cannot be written undoes the install too, the same
 * as the web install: the operator asked for both, and an upgrade left
 * half-done would leave the new version on disk under a `plugins.lock` pin that
 * still names the old one.
 */
export async function installScannedPlugin(
  input: InstallScannedPluginInput,
): Promise<PluginLockEntry | undefined> {
  const { storage, pluginsDir, grant, personalityId } = input;
  const runNpm = input.runNpm ?? execNpm;
  const spec = `${grant.package}@${grant.version}`;
  // Both read before anything changes: `npm install` replaces the previous
  // copy, and `recordGrant` replaces the previous grant.
  const previous = await findPreviousCopy({
    storage,
    pluginsDir,
    personalitiesDir: input.personalitiesDir,
    name: grant.package,
    preferredPersonality: personalityId,
  });
  const previousGrant = (await readGrants(storage, pluginsDir))[grant.id] ?? null;
  await recordGrant(storage, pluginsDir, grant);

  const undo: UndoPluginInstallInput = {
    storage,
    pluginsDir,
    name: grant.package,
    previous,
    runNpm,
    grant: { id: grant.id, recorded: grant, previous: previousGrant },
  };
  const retry = `Fix what the error reports, then retry: ethos plugin install ${spec}${personalityId === undefined ? '' : ` --personality ${personalityId}`}`;
  let stage: InstallStage = 'before-npm-install';
  let integrity: string;
  try {
    ({ integrity } = await installPackedTarball({
      package: grant.package,
      version: grant.version,
      pluginsDir,
      storage,
      expected: {
        integrity: input.scannedIntegrity,
        from: 'npm recorded for the copy the safety scan read',
      },
      runNpm: async (args) => {
        if (args[0] === 'install') stage = 'npm-install-failed';
        await runNpm(args);
        if (args[0] === 'install') stage = 'after-npm-install';
      },
    }));
  } catch (err) {
    if (err instanceof PluginIntegrityError) {
      throw await undoneInstall(undo, stage, {
        found: `The npm tarball of ${spec} does not match the copy the safety scan read (expected ${err.expected}, got ${err.actual}).`,
        action:
          'Retry the install. If it is refused again, do not install this package: the registry served bytes that differ from the ones the safety scan read.',
      });
    }
    const failed = describeInstallFailure(err);
    const found =
      stage === 'before-npm-install'
        ? `Fetching the verified tarball of ${spec} failed (${failed}).`
        : stage === 'npm-install-failed'
          ? `npm install of the verified tarball of ${spec} failed (${failed}).`
          : `npm installed the verified tarball of ${spec}, but rewriting ${join(pluginsDir, 'package.json')} and package-lock.json to record it failed (${failed}).`;
    throw await undoneInstall(undo, stage, { found, action: retry });
  }
  if (personalityId === undefined) return undefined;

  const personalityDir = join(input.personalitiesDir, personalityId);
  try {
    // Read first: the pin replaces any entry already pinned under this id.
    const previousPin = (await readLockfile(storage, personalityDir))[grant.id] ?? null;
    undo.pin = {
      personalityId,
      personalityDir,
      pluginId: grant.id,
      written: pluginLockEntryFor(grant, integrity),
      previous: previousPin,
    };
    return await pinPluginToPersonality({ storage, personalityDir, draft: grant, integrity });
  } catch (err) {
    throw await undoneInstall(undo, 'after-npm-install', {
      found: `npm installed the verified tarball of ${spec}, but pinning it to personality ${personalityId} failed (${describeInstallFailure(err)}).`,
      action: retry,
    });
  }
}

/**
 * `ethos plugin install` failed after its grant was recorded, and was undone
 * (`undoPluginInstall`). The message is the failure plus the end state the undo
 * confirmed (`describeUndoneInstall`); `outcome` is that end state.
 */
export class PluginInstallUndoneError extends Error {
  constructor(
    readonly outcome: InstallUndoOutcome,
    message: string,
    readonly action: string,
  ) {
    super(message);
    this.name = 'PluginInstallUndoneError';
  }
}

async function undoneInstall(
  undo: UndoPluginInstallInput,
  stage: InstallStage,
  failure: { found: string; action: string },
): Promise<PluginInstallUndoneError> {
  const outcome = await undoPluginInstall({ ...undo, stage });
  const { cause, action } = describeUndoneInstall({
    undo,
    outcome,
    found: failure.found,
    action: failure.action,
    restartsWhen: 'ethos next starts',
  });
  return new PluginInstallUndoneError(outcome, cause, action);
}

const SHA512_SRI_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/**
 * The SRI npm recorded for the package the safety scan read — the registry's
 * `dist.integrity`, which npm checked the download against. Read from the scan
 * prefix's `package-lock.json`, else the hidden `node_modules/.package-lock.json`
 * npm writes even under `package-lock=false` (both verified on npm 11.12.1).
 *
 * Fails closed: no sha512 integrity means npm did not fetch a registry tarball
 * for it (a git URL, a local path), so there is nothing to hold the final
 * install to — and that install fetches `name@version` from the registry, which
 * is not what was scanned.
 */
export async function readScannedIntegrity(
  tmpDir: string,
  pkgDir: string,
  pkgArg: string,
): Promise<string> {
  const key = relative(tmpDir, pkgDir).split(sep).join('/');
  const locks = [
    join(tmpDir, 'package-lock.json'),
    join(tmpDir, 'node_modules', '.package-lock.json'),
  ];
  for (const lockPath of locks) {
    let lock: { packages?: Record<string, { integrity?: unknown } | null> } | null;
    try {
      lock = JSON.parse(await readFile(lockPath, 'utf-8')) as typeof lock;
    } catch {
      continue;
    }
    const integrity = lock?.packages?.[key]?.integrity;
    if (typeof integrity === 'string' && SHA512_SRI_RE.test(integrity)) return integrity;
  }
  throw new EthosError({
    code: 'PLUGIN_INSTALL_FAILED',
    cause: `npm recorded no sha512 integrity for the package scanned from '${pkgArg}', so the install cannot be held to the bytes the safety scan read`,
    action:
      'Install a published npm package by name (e.g. ethos-plugin-foo or ethos-plugin-foo@1.2.3), not a git URL, tarball, or local path.',
  });
}

// ---------------------------------------------------------------------------
// Consent — the operator consequence sentence and the grant decision
// ---------------------------------------------------------------------------

/**
 * The G5 sentence, shown at the moment the operator takes the risk on rather
 * than in a doc they read afterwards.
 *
 * Do not soften this. `PluginLoader` `import()`s the plugin's entry module into
 * the ethos process; the plugin shares the process, the environment, the
 * filesystem, and the API keys. There is no sandbox to fall back on.
 */
export const PLUGIN_CONSEQUENCE =
  'Installing a plugin is equivalent to running arbitrary code as your user.';

/** Print the consequence block plus the capabilities the grant will record. */
function printPluginConsequence(draft: PluginGrantDraft): void {
  const network =
    draft.capabilities.network === null
      ? '(none declared)'
      : draft.capabilities.network.length > 0
        ? draft.capabilities.network.join(' · ')
        : '(any host)';

  console.log(`\n${c.bold}What installing this plugin means${c.reset}`);
  console.log(`  ${PLUGIN_CONSEQUENCE}`);
  console.log(
    `  ${c.dim}${draft.package} runs inside the ethos process — your files, your environment,${c.reset}`,
  );
  console.log(
    `  ${c.dim}your API keys. The safety scan is a static, pre-install read of the source${c.reset}`,
  );
  console.log(
    `  ${c.dim}for known-dangerous patterns. It is advisory: it sandboxes nothing, it can${c.reset}`,
  );
  console.log(`  ${c.dim}be evaded, and nothing confines this plugin once it is loaded.${c.reset}`);
  console.log(
    `  ${c.dim}The capabilities below are what the plugin declares, not limits it is held to.${c.reset}`,
  );

  console.log(`\n${c.bold}Grant to record${c.reset}`);
  console.log(`  ${'Plugin'.padEnd(20)}${draft.id}  ${c.dim}${draft.source}${c.reset}`);
  console.log(`  ${'Declares shell'.padEnd(20)}${draft.capabilities.shell ? 'yes' : 'no'}`);
  console.log(`  ${'Declares network'.padEnd(20)}${network}`);
  console.log(
    `  ${'Scan at install'.padEnd(20)}${draft.scan.tier} · ${draft.scan.findings.length} finding(s)`,
  );
}

/**
 * Resolve the install decision without hanging on stdin — same shape as the
 * skills install path's `resolveYellowFindings`.
 *
 * Exported for testing; not part of the public CLI surface.
 *
 * @returns `'proceed'` when `--yes` records consent unattended, `'prompt'` when
 * the caller must ask. Throws `EthosError` when consent cannot be taken at all.
 */
export function resolvePluginConsent(opts: {
  pkg: string;
  yesFlag: boolean;
  isTTY: boolean;
  managed: boolean;
}): 'proceed' | 'prompt' {
  const { pkg, yesFlag, isTTY, managed } = opts;

  // --yes RECORDS consent unattended (CI, managed hosts). It does not skip the
  // grant — the grant is still written with `consent: 'flag'` so an operator
  // can see later that nobody was at the keyboard.
  if (yesFlag) {
    console.log(`\n${c.yellow}⚠ Consent recorded for '${pkg}' via --yes.${c.reset}`);
    return 'proceed';
  }

  if (!isTTY || managed) {
    throw new EthosError({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `Installing '${pkg}' needs a recorded capability grant and stdin is not a TTY.`,
      action: 'Re-run with --yes to record the grant unattended, or install interactively.',
    });
  }

  return 'prompt';
}

// ---------------------------------------------------------------------------
// Grants — inspect and revoke
// ---------------------------------------------------------------------------

async function listGrants(jsonMode: boolean): Promise<void> {
  const dir = pluginsDir();
  const grants = await readGrants(getStorage(), dir);
  const entries = Object.values(grants).sort((a, b) => a.id.localeCompare(b.id));

  if (jsonMode) {
    writeJson(entries);
    return;
  }

  if (entries.length === 0) {
    console.log(`\n${c.dim}No plugin grants recorded.${c.reset}`);
    console.log(
      `${c.dim}A grant is written when you run: ${c.reset}ethos plugin install <package>\n`,
    );
    return;
  }

  console.log(`\n${c.bold}Plugin grants${c.reset}  ${c.dim}(${grantsPath(dir)})${c.reset}`);
  for (const g of entries) {
    const network =
      g.capabilities.network === null
        ? '(none declared)'
        : g.capabilities.network.length > 0
          ? g.capabilities.network.join(' · ')
          : '(any host)';
    const red = g.scan.findings.filter((f) => f.severity === 'red').length;
    const yellow = g.scan.findings.filter((f) => f.severity === 'yellow').length;

    console.log(`\n  ${c.cyan}${g.id}${c.reset}  ${c.dim}v${g.version}${c.reset}`);
    console.log(`    ${'granted'.padEnd(14)}${g.grantedAt} ${c.dim}(${g.consent})${c.reset}`);
    console.log(`    ${'source'.padEnd(14)}${c.dim}${g.source}${c.reset}`);
    console.log(
      `    ${'declares'.padEnd(14)}${c.dim}shell: ${g.capabilities.shell ? 'yes' : 'no'} · network: ${network}${c.reset}`,
    );
    console.log(
      `    ${'scan at grant'.padEnd(14)}${c.dim}${g.scan.tier} · ${red} red · ${yellow} yellow${c.reset}`,
    );
    for (const f of g.scan.findings) {
      const color = f.severity === 'red' ? c.red : c.yellow;
      console.log(`      ${color}${f.severity}${c.reset}  ${c.dim}${f.rule}${c.reset}`);
    }
    if (g.revokedAt) {
      console.log(`    ${c.red}revoked${c.reset}       ${g.revokedAt}`);
    }
  }

  console.log(
    `\n${c.dim}A grant records consent; it is not a sandbox. Revoking stops the loader from${c.reset}`,
  );
  console.log(
    `${c.dim}importing the plugin again — it cannot undo what an already-loaded plugin did.${c.reset}\n`,
  );
}

async function revokePluginGrant(pluginId: string): Promise<void> {
  const dir = pluginsDir();
  const revoked = await revokeGrant(getStorage(), dir, pluginId);
  if (!revoked) {
    console.error(`${c.red}No active grant for '${pluginId}'.${c.reset}`);
    console.error(`${c.dim}→ ethos plugin grants${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.green}✓${c.reset} Revoked the grant for ${c.cyan}${pluginId}${c.reset}.`);
  console.log(
    `${c.dim}The loader will refuse to import it from the next load onwards. Anything it${c.reset}`,
  );
  console.log(
    `${c.dim}already did in a running process stands — revocation cannot claw that back.${c.reset}`,
  );
  console.log(`${c.dim}Remove the package too with: ${c.reset}ethos plugin remove ${pluginId}`);
}

/**
 * Discover the installed package directory from the manifest npm writes into
 * the temp prefix dir. Fails closed if the manifest is absent or ambiguous —
 * the caller must not scan or install when this throws.
 */
export async function findInstalledPkgDir(tmpDir: string, pkgArg: string): Promise<string> {
  let manifest: { dependencies?: Record<string, string> } = {};
  try {
    manifest = JSON.parse(await readFile(join(tmpDir, 'package.json'), 'utf-8')) as typeof manifest;
  } catch {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `npm did not produce a package manifest — cannot verify what was installed for '${pkgArg}'`,
      action: 'Try a plain package name (e.g. ethos-plugin-foo) rather than a tarball or git URL.',
    });
  }
  const names = Object.keys(manifest.dependencies ?? {});
  if (names.length === 0) {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `npm manifest has no recorded dependencies — cannot locate installed package for '${pkgArg}'`,
      action: 'Ensure the package name is correct and try again.',
    });
  }
  if (names.length > 1) {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `npm manifest has unexpected multiple dependencies (${names.join(', ')}) — cannot safely identify '${pkgArg}'`,
      action: 'Install plugins one at a time.',
    });
  }
  const pkgName = names[0];
  const pkgDir = join(tmpDir, 'node_modules', pkgName);
  try {
    await readFile(join(pkgDir, 'package.json'), 'utf-8');
  } catch {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `Installed package directory not found for '${pkgArg}' — expected package.json at ${join(pkgDir, 'package.json')}`,
      action:
        'The package may have installed under a different name. Use a plain npm package name rather than a tarball, git URL, or local path.',
    });
  }
  return pkgDir;
}

/** The parsed package.json, or `undefined` when unreadable or malformed. The
 *  `ethos.permissions` inside it is parsed by plugin-loader's `readPluginPermissions`,
 *  the same parser `draftPluginGrant` uses — not by a copy here. */
async function readPackageJson(pkgDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'));
  } catch {
    return undefined;
  }
}

async function walkAndScan(
  dir: string,
  permissions: PluginScanPermissions,
  out: ScanFinding[],
): Promise<void> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = String(e.name);
    if (e.isDirectory()) {
      if (name === 'node_modules') continue;
      await walkAndScan(join(dir, name), permissions, out);
    } else if (
      /\.[jt]sx?$|\.(?:cjs|mjs)$/.test(name) &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.d.cts') &&
      !name.endsWith('.d.mts')
    ) {
      const src = await readFile(join(dir, name), 'utf-8').catch(() => null);
      if (src) out.push(...scanPluginCode(src, permissions).findings);
    }
  }
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function runCredentials(args: string[]): Promise<void> {
  const pluginId = args[0];
  if (!pluginId) {
    console.log(
      'Usage: ethos plugin credentials <pluginId> [--list | --set KEY[=VALUE] | --clear KEY]',
    );
    process.exit(1);
  }

  const flag = args[1] ?? '--list';
  const dataDir = join(homedir(), '.ethos');
  // Metadata sidecars (`<key>.meta`) and any pre-vault plaintext credentials.
  const credDir = join(dataDir, 'plugins', pluginId, 'credentials');
  // G-SEC — credential VALUES live only here, under `plugins/<pluginId>/<key>`,
  // the same refs the plugin api and the `plugins.*` RPC use.
  const secrets = new FileSecretsResolver({
    dir: join(ethosDir(), 'secrets'),
    storage: getStorage(),
  });
  await migrateLegacyPluginCredentials({
    secrets,
    storage: getStorage(),
    pluginId,
    legacyDir: credDir,
  });

  switch (flag) {
    case '--list': {
      await listCredentials(pluginId, credDir, secrets);
      break;
    }
    case '--set': {
      const keyArg = args[2];
      if (!keyArg) {
        console.log('Usage: ethos plugin credentials <pluginId> --set KEY[=VALUE]');
        process.exit(1);
      }
      await setCredential(pluginId, credDir, keyArg, secrets);
      break;
    }
    case '--clear': {
      const key = args[2];
      if (!key) {
        console.log('Usage: ethos plugin credentials <pluginId> --clear KEY');
        process.exit(1);
      }
      await clearCredential(pluginId, credDir, key, secrets);
      break;
    }
    default:
      console.log(
        'Usage: ethos plugin credentials <pluginId> [--list | --set KEY[=VALUE] | --clear KEY]',
      );
      process.exit(1);
  }
}

async function readPluginCredentialDeclarations(
  pluginId: string,
): Promise<Array<{ key: string; label: string; type: string; refreshHint?: string }>> {
  const dir = pluginsDir();
  const candidates = [
    join(dir, pluginId, 'package.json'),
    join(dir, 'node_modules', pluginId, 'package.json'),
  ];

  for (const pkgPath of candidates) {
    try {
      const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
      const ethosField = raw.ethos as Record<string, unknown> | undefined;
      if (ethosField && Array.isArray(ethosField.credentials)) {
        return ethosField.credentials as Array<{
          key: string;
          label: string;
          type: string;
          refreshHint?: string;
        }>;
      }
    } catch {
      // package.json not found at this candidate path
    }
  }
  return [];
}

async function listCredentials(
  pluginId: string,
  credDir: string,
  secrets: SecretsResolver,
): Promise<void> {
  const declared = await readPluginCredentialDeclarations(pluginId);

  const prefix = pluginCredentialPrefix(pluginId);
  const entries = (await secrets.list(prefix)).map((ref) => ref.slice(prefix.length));

  const allKeys = new Set([...declared.map((d) => d.key), ...entries]);

  if (allKeys.size === 0) {
    console.log(`\n${c.dim}No credentials declared or set for ${pluginId}.${c.reset}`);
    return;
  }

  console.log();
  for (const key of allKeys) {
    const isSet = entries.includes(key);
    let detail = `${c.dim}not set${c.reset}`;

    if (isSet) {
      try {
        const metaRaw = await readFile(join(credDir, `${key}.meta`), 'utf-8');
        const meta = JSON.parse(metaRaw) as { updatedAt?: string };
        if (meta.updatedAt) {
          const ageMs = Date.now() - new Date(meta.updatedAt).getTime();
          const ageH = Math.floor(ageMs / (1000 * 60 * 60));
          detail = `${c.green}set${c.reset}  ${c.dim}updated ${ageH}h ago${c.reset}`;
          const decl = declared.find((d) => d.key === key);
          if (decl?.refreshHint === 'daily' && ageH > 20) {
            detail += `  ${c.yellow}-- daily rotation due${c.reset}`;
          } else if (decl?.refreshHint === 'weekly' && ageH > 144) {
            detail += `  ${c.yellow}-- weekly rotation due${c.reset}`;
          }
        } else {
          detail = `${c.green}set${c.reset}`;
        }
      } catch {
        detail = `${c.green}set${c.reset}`;
      }
    }

    console.log(`  ${c.cyan}${key}${c.reset}  ${detail}`);
  }
  console.log();
}

async function setCredential(
  pluginId: string,
  credDir: string,
  keyArg: string,
  secrets: SecretsResolver,
): Promise<void> {
  const eqIdx = keyArg.indexOf('=');
  let key: string;
  let value: string;

  if (eqIdx >= 0) {
    key = keyArg.slice(0, eqIdx);
    value = keyArg.slice(eqIdx + 1);
  } else {
    key = keyArg;
    value = await promptSecret(`Enter value for ${key}: `);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    console.error(
      `${c.red}Invalid key "${key}" -- must be alphanumeric, underscores, hyphens.${c.reset}`,
    );
    process.exit(1);
  }

  // The value goes to the vault and nowhere else; only the `updatedAt` sidecar
  // stays on disk. Same ref and same sidecar path as PluginApiImpl.setSecret
  // (packages/plugin-sdk/src/index.ts), so the two writers cannot drift.
  await secrets.set(pluginCredentialRef(pluginId, key), value);

  // 0o700 — same lockdown PluginApiImpl.setSecret applies to this directory.
  await mkdir(credDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(credDir, `${key}.meta`),
    JSON.stringify({ updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );

  console.log(`${c.green}✓${c.reset} Credential ${c.cyan}${key}${c.reset} saved for ${pluginId}.`);
}

function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function clearCredential(
  pluginId: string,
  credDir: string,
  key: string,
  secrets: SecretsResolver,
): Promise<void> {
  await secrets.delete(pluginCredentialRef(pluginId, key));
  await rm(join(credDir, `${key}.meta`), { force: true }).catch(() => {});

  console.log(`${c.green}✓${c.reset} Credential ${c.cyan}${key}${c.reset} cleared.`);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// The personality write-back lives with the rest of the install record in
// `@ethosagent/plugin-loader` (`install-record.ts`), shared with the web install.
export { updatePersonalityPluginConfig } from '@ethosagent/plugin-loader';

async function listPlugins(args: string[] = []): Promise<void> {
  const jsonMode = args.includes('--json');
  const dir = pluginsDir();
  const nmDir = join(dir, 'node_modules');

  const manual: string[] = [];
  const npm: Array<{ name: string; version: string }> = [];

  // Direct subdirectories (manually dropped in, excluding node_modules)
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') {
        manual.push(e.name);
      }
    }
  } catch {
    // plugins dir doesn't exist yet
  }

  // npm-installed: ethos-plugin-* and @ethos-plugins/* in node_modules
  try {
    const entries = await readdir(nmDir, { withFileTypes: true });
    const candidates = entries.filter(
      (e) =>
        e.isDirectory() &&
        (e.name.startsWith('ethos-plugin-') || e.name.startsWith('@ethos-plugins')),
    );

    for (const e of candidates) {
      const pkgPath = join(nmDir, e.name, 'package.json');
      try {
        const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
        npm.push({ name: e.name, version: raw.version ?? '?' });
      } catch {
        npm.push({ name: e.name, version: '?' });
      }
    }

    // Also scan scoped @ethos-plugins/ subdirs
    for (const e of entries.filter((x) => x.isDirectory() && x.name.startsWith('@'))) {
      try {
        const scoped = await readdir(join(nmDir, e.name), { withFileTypes: true });
        for (const s of scoped.filter((x) => x.isDirectory())) {
          const name = `${e.name}/${s.name}`;
          const pkgPath = join(nmDir, name, 'package.json');
          try {
            const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
            npm.push({ name, version: raw.version ?? '?' });
          } catch {
            npm.push({ name, version: '?' });
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // node_modules doesn't exist yet
  }

  if (jsonMode) {
    const result: Array<{ name: string; version?: string; source: string }> = [];
    for (const p of npm) {
      const entry: { name: string; version?: string; source: string } = {
        name: p.name,
        source: 'npm',
      };
      if (p.version !== '?') entry.version = p.version;
      result.push(entry);
    }
    for (const name of manual) {
      result.push({ name, source: 'manual' });
    }
    writeJson(result);
    return;
  }

  if (manual.length === 0 && npm.length === 0) {
    console.log(`\n${c.dim}No plugins installed.${c.reset}`);
    console.log(`${c.dim}Install one with: ${c.reset}ethos plugin install ethos-plugin-<name>\n`);
    return;
  }

  console.log();
  if (npm.length > 0) {
    console.log(`${c.bold}npm plugins${c.reset}  ${c.dim}(${dir}/node_modules)${c.reset}`);
    for (const p of npm) {
      console.log(`  ${c.cyan}${p.name}${c.reset}  ${c.dim}v${p.version}${c.reset}`);
    }
    console.log();
  }
  if (manual.length > 0) {
    console.log(`${c.bold}manual plugins${c.reset}  ${c.dim}(${dir})${c.reset}`);
    for (const name of manual) {
      console.log(`  ${c.cyan}${name}${c.reset}`);
    }
    console.log();
  }
}
