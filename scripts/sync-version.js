#!/usr/bin/env node
// Reads VERSION and syncs the version field in the seven public package.json files.
// Idempotent — files already at the correct version are left untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`error: invalid VERSION: "${version}"`);
  process.exit(1);
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

let updated = 0;

for (const pkg of PUBLIC_PACKAGES) {
  const pkgPath = join(root, pkg, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const json = JSON.parse(raw);
  if (json.version === version) continue;
  const old = json.version;
  json.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ${pkg}/package.json  ${old} → ${version}`);
  updated++;
}

console.log(`sync-version: ${version} · ${updated} file(s) updated`);
