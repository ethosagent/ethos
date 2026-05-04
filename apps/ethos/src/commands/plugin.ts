import { spawnSync } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  canInstall,
  type PluginScanPermissions,
  type ScanFinding,
  scanPluginCode,
} from '@ethosagent/safety-scanner';

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
      const pkg = args[1];
      if (!pkg) {
        console.log('Usage: ethos plugin install <package>');
        process.exit(1);
      }
      await installPlugin(pkg);
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
      console.log(`\n${c.green}✓ Removed.${c.reset}`);
      break;
    }

    case 'list': {
      await listPlugins();
      break;
    }

    default:
      console.log('Usage: ethos plugin [install <pkg> | remove <pkg> | list]');
  }
}

// ---------------------------------------------------------------------------
// Install: download to temp, scan, prompt, then commit
// ---------------------------------------------------------------------------

async function installPlugin(pkg: string): Promise<void> {
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

  try {
    // Step 2: locate the package directory under node_modules
    const pkgDir = join(tmpDir, 'node_modules', pkgDirFromArg(pkg));

    // Step 3: read declared permissions from package.json (ethos.permissions)
    const permissions = await readPluginPermissions(pkgDir);

    // Step 4: recursive scan
    const findings: ScanFinding[] = [];
    await walkAndScan(pkgDir, permissions, findings);
    const hasRed = findings.some((f) => f.severity === 'red');
    const hasYellow = findings.some((f) => f.severity === 'yellow');
    const scanResult = { findings, hasRed, hasYellow };

    // Step 5: show tier badge + findings
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

    // Step 6: decide
    const decision = canInstall(scanResult, tier);
    if (!decision.allowed) {
      if (hasRed) {
        console.log(`\n${c.red}✗ Install blocked:${c.reset} ${decision.blockedBy}`);
        console.log(`${c.dim}Review the findings above or choose a different package.${c.reset}`);
        process.exit(1);
      }
      // Yellow-only: prompt user to acknowledge
      const confirmed = await promptConfirm(
        `\n${c.yellow}⚠ Install '${pkg}' with the warnings above? [y/N]${c.reset} `,
      );
      if (!confirmed) {
        console.log(`${c.dim}Install cancelled.${c.reset}`);
        process.exit(0);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // Step 7: approved — run the real install in the plugins dir
  console.log(
    `\n${c.dim}Installing ${c.reset}${c.bold}${pkg}${c.reset}${c.dim} to ${dir}...${c.reset}\n`,
  );
  const result = spawnSync('npm', ['install', '--prefix', dir, pkg], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`${c.red}Install failed.${c.reset}`);
    process.exit(result.status ?? 1);
  }
  console.log(`\n${c.green}✓ Installed.${c.reset} Restart ethos to load the plugin.`);
}

/** Derive the node_modules subdirectory path from a package arg (strips version, handles scoped). */
function pkgDirFromArg(pkg: string): string {
  if (pkg.startsWith('@')) {
    // @scope/name[@version] → @scope/name
    const secondAt = pkg.indexOf('@', 1);
    return secondAt > 0 ? pkg.slice(0, secondAt) : pkg;
  }
  const atIdx = pkg.indexOf('@');
  return atIdx > 0 ? pkg.slice(0, atIdx) : pkg;
}

async function readPluginPermissions(pkgDir: string): Promise<PluginScanPermissions> {
  try {
    const raw = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const ethos = raw.ethos;
    if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return {};
    const perms = (ethos as Record<string, unknown>).permissions;
    if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return {};
    const p = perms as Record<string, unknown>;
    const result: PluginScanPermissions = {};
    if (p.shell === true) result.shell = true;
    if (Array.isArray(p.network)) {
      result.network = p.network.filter((x): x is string => typeof x === 'string');
    } else if (p.network === true) {
      result.network = [];
    }
    return result;
  } catch {
    return {};
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
    } else if (/\.[jt]s$/.test(name) && !name.endsWith('.d.ts')) {
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
// List
// ---------------------------------------------------------------------------

async function listPlugins(): Promise<void> {
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
