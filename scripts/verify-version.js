#!/usr/bin/env node
// Pre-flight gates for releasing Ethos.
// G1  version sync  — all five public package.json versions == VERSION
// G2  no 0.0.0      — none of the five public packages at the placeholder version
// G3  clean tree    — git status --porcelain is empty
// G4  on main       — HEAD == origin/main
// G5  no tag yet    — v{VERSION} doesn't exist locally or on remote
// G8  NPM_TOKEN     — required secret present (CI only)
//
// Pass --pr to run only G1 + G2 (pull-request gate in ci.yml).
// G7 (tests green) is NOT in this script; make verify runs `pnpm check` separately.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prOnly = process.argv.includes('--pr');
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
// Validate version to prevent command injection — must be a semver-like string
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/.test(version)) {
  console.error(`  ✗ VERSION file contains invalid version string: "${version}"`);
  process.exit(1);
}
let failures = 0;

function fail(gate, msg) {
  console.error(`  ✗ ${gate}: ${msg}`);
  failures++;
}

function pass(gate, msg) {
  console.log(`  ✓ ${gate}: ${msg}`);
}

function exec(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
}

const PUBLIC_PACKAGES = [
  'apps/ethos',
  'packages/types',
  'packages/core',
  'packages/plugin-contract',
  'packages/plugin-sdk',
  'packages/web-contracts',
  'packages/sdk',
];

const pkgs = PUBLIC_PACKAGES.map((dir) => ({
  path: `${dir}/package.json`,
  pkg: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')),
}));

// G1: all public package versions == VERSION
const drifted = pkgs.filter(({ pkg }) => pkg.version !== version);
if (drifted.length > 0) {
  for (const { path, pkg } of drifted)
    fail(
      'G1',
      `${path} has ${pkg.version}, expected ${version} — run: make version-set NEW=${version}`,
    );
} else {
  pass('G1', `all ${pkgs.length} public package.json files == ${version}`);
}

// G2: no 0.0.0
const zeroes = pkgs.filter(({ pkg }) => pkg.version === '0.0.0');
if (zeroes.length > 0) {
  for (const { path } of zeroes)
    fail('G2', `0.0.0 not allowed: ${path} — run: make version-set NEW=${version}`);
} else {
  pass('G2', 'no 0.0.0 versions');
}

if (!prOnly) {
  // G3: working tree clean
  try {
    const status = exec('git status --porcelain');
    if (status) fail('G3', `working tree is dirty — commit or stash first:\n${status}`);
    else pass('G3', 'working tree clean');
  } catch {
    fail('G3', 'could not check git status');
  }

  // G4: HEAD == origin/main
  try {
    const head = exec('git rev-parse HEAD');
    const main = exec('git rev-parse origin/main');
    if (head !== main) {
      fail(
        'G4',
        `HEAD (${head.slice(0, 8)}) != origin/main (${main.slice(0, 8)}) — push your commits before tagging`,
      );
    } else {
      pass('G4', 'HEAD == origin/main');
    }
  } catch (e) {
    fail(
      'G4',
      `could not verify HEAD vs origin/main: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // G5: tag does not already exist
  const tag = `v${version}`;
  let tagExistsLocally = false;
  try {
    execFileSync('git', ['rev-parse', tag], { cwd: root, stdio: 'pipe' });
    tagExistsLocally = true;
  } catch {
    // expected — tag doesn't exist yet
  }
  if (tagExistsLocally) {
    fail('G5', `tag ${tag} already exists locally — delete with: git tag -d ${tag}`);
  } else {
    try {
      const remote = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${tag}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      if (remote)
        fail(
          'G5',
          `tag ${tag} already exists on remote — delete with: git push origin :refs/tags/${tag}`,
        );
      else pass('G5', `tag ${tag} not yet created`);
    } catch {
      pass('G5', `tag ${tag} not yet created (remote check skipped)`);
    }
  }

  // G8: NPM_TOKEN in CI
  if (process.env.CI) {
    if (!process.env.NPM_TOKEN)
      fail('G8', 'NPM_TOKEN is not set — add it as a repository secret named NPM_TOKEN');
    else pass('G8', 'NPM_TOKEN present');
  }
}

if (failures > 0) {
  console.error(`\nverify: ${failures} gate(s) failed`);
  process.exit(1);
}

console.log(
  `\n${prOnly ? 'PR gates' : 'All gates'} passed${prOnly ? '' : ` — ready to release v${version}`}.`,
);
