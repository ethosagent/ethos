#!/usr/bin/env node
// Reads VERSION and syncs the version field in every workspace package.json.
// Idempotent — files already at the correct version are left untouched.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`error: invalid VERSION: "${version}"`);
  process.exit(1);
}

const dirs = ['apps', 'packages', 'extensions'];
let updated = 0;

for (const dir of dirs) {
  const dirPath = join(root, dir);
  if (!existsSync(dirPath)) continue;
  for (const sub of readdirSync(dirPath)) {
    const pkgPath = join(dirPath, sub, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.version === version) continue;
    const old = pkg.version;
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`  ${dir}/${sub}/package.json  ${old} → ${version}`);
    updated++;
  }
}

console.log(`sync-version: ${version} · ${updated} file(s) updated`);
