#!/usr/bin/env bash
# Verify every bare npm module bundled into the CLI is declared in
# apps/ethos/package.json dependencies/optionalDependencies.
#
# tsup bundles all @ethosagent/* workspace internals INTO apps/ethos/dist
# (see apps/ethos/tsup.config.ts) while externalizing bare modules — so any
# bare import in any bundled workspace source becomes a runtime require of
# the CLI package. If it isn't declared there, a fresh `npm install
# @ethosagent/cli` breaks at startup with ERR_MODULE_NOT_FOUND (dev hides
# this via pnpm workspace hoisting). This gate walks the workspace import
# graph from apps/ethos/src and fails on any undeclared external module.
# Called by: scripts/run-checks.sh (blocking), .github/workflows/release.yml
# (before publish); local devs via `make bundle-deps`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec node --input-type=module - <<'EOF'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';

// Kept external by tsup on purpose (published separately for plugin authors);
// they are real dependencies of apps/ethos, not bundled sources to walk into.
const EXTERNAL_WORKSPACE = new Set(['@ethosagent/core', '@ethosagent/types']);

// False-positive allowlist — bare specifiers matched by the import regex that
// are NOT runtime requirements of the published CLI bundle. One justification per entry.
const ALLOWLIST = new Set([
  // antd: imported only by packages/design-tokens/src/antd.ts — a subpath entry
  // ('@ethosagent/design-tokens/antd') consumed solely by apps/web, tree-shaken
  // out of the CLI bundle (no `from "antd"` in dist), and declared as an
  // optional peerDependency of design-tokens. The walk is package-granular so
  // it can't see that this one file is unreachable from the CLI entry.
  'antd',
]);

const builtins = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));

// Workspace package dirs, from the `packages:` globs in pnpm-workspace.yaml —
// the same list pnpm itself links. A hard-coded one-level walk of
// packages/ extensions/ apps/ used to miss nested packages
// (packages/safety/*), so undici — imported only by
// packages/safety/network/src/safe-fetch.ts — shipped undeclared in 0.8.0.
// Supported glob shapes are the ones pnpm-workspace.yaml uses: an exact dir
// (`docs`) and a one-level wildcard (`packages/*`). Anything else is refused
// loudly rather than silently skipped, since a skipped package is a false
// negative on this gate.
const workspaceGlobs = () => {
  const globs = [];
  let inPackages = false;
  for (const line of readFileSync('pnpm-workspace.yaml', 'utf8').split('\n')) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line);
    else if (inPackages) {
      const m = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) globs.push(m[1]);
    }
  }
  if (globs.length === 0) throw new Error('BUNDLE-DEPS: no packages: globs found in pnpm-workspace.yaml');
  return globs;
};

const workspaceDirs = () => {
  const dirs = [];
  for (const glob of workspaceGlobs()) {
    if (glob.startsWith('!')) throw new Error(`BUNDLE-DEPS: unsupported negated workspace glob ${glob}`);
    if (glob.endsWith('/*') && !glob.slice(0, -2).includes('*')) {
      const parent = glob.slice(0, -2);
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent)) dirs.push(join(parent, entry));
    } else if (!glob.includes('*')) {
      dirs.push(glob);
    } else {
      throw new Error(`BUNDLE-DEPS: unsupported workspace glob ${glob} — teach workspaceDirs() it`);
    }
  }
  return dirs;
};

// Map workspace package name -> src dir.
const srcDirs = new Map();
for (const dir of workspaceDirs()) {
  const pkgJson = join(dir, 'package.json');
  if (!existsSync(pkgJson)) continue;
  const name = JSON.parse(readFileSync(pkgJson, 'utf8')).name;
  const src = join(dir, 'src');
  if (name && existsSync(src)) srcDirs.set(name, src);
}

const sourceFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

// Remove `//` and `/* */` comments. Prose in a comment is not an import: a JSDoc
// line reading `from "unset"` (packages/web-contracts/src/schemas.ts) is a valid
// bare specifier as far as `toModuleName` can tell, so it has to be gone before
// the extraction regexes run.
//
// A character scanner rather than a regex, because a regex that deletes from `//`
// to end-of-line also deletes the `//` inside "https://…" and every import after
// it on that line — a false NEGATIVE on this gate, which is the failure that
// actually ships a broken package. String and template-literal bodies are copied
// through untouched, so anything the old extraction found inside a string it
// still finds.
//
// Not handled: regex literals. A regex containing a quote (`/["']/`) is read as
// the start of a string. Quoted-string state ends at an unescaped newline, so
// that misread can never reach past the line the regex is on; a backtick or a
// `/*` inside one is the only way it could, and neither occurs in this repo —
// the module set this walk produces is unchanged by this function apart from
// the dropped `unset`.
const stripComments = (code) => {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n'; // keep line structure for the ^import pattern
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < code.length) {
        const s = code[i];
        if (s === '\\') {
          out += code.slice(i, i + 2); // escape: consume both chars, quote can't close
          i += 2;
          continue;
        }
        out += s;
        i++;
        if (s === c) break;
        if (s === '\n' && c !== '`') break; // unterminated — don't run past the line
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

// Extract bare import specifiers from one file (static, side-effect, dynamic,
// require), each tagged `static` when it runs the moment the bundle loads.
const specifiers = (file) => {
  // Type-only imports are erased by tsup — they never reach the bundle.
  const code = stripComments(readFileSync(file, 'utf8'))
    .replace(/\b(?:import|export)\s+type\b[\s\S]{0,500}?from\s*["'][^"']*["']/g, '');
  const found = [];
  // [regex, isStatic]. Static = `import … from` / `export … from` / side-effect
  // `import 'x'`: tsup (splitting: false) hoists every one of them to the top of
  // the single dist/index.js, so it runs when ANY command starts.
  const patterns = [
    // Static `import … from` / `export … from`, anchored to statement start: the
    // keyword begins a line (after indentation) or follows a `;`. The clause
    // between keyword and `from` may span lines (a multi-line named import) but
    // cannot contain `;`, parens, `=` or a backtick — no import/export clause
    // does. An unanchored `\bfrom\s+"x"` matched code quoted inside string
    // literals: the eval-harness fixtures in
    // extensions/eval-harness/src/decision-seeds.ts embed
    // `import { render } from "acme-widgets"` and `import { it } from 'vitest'`
    // as data, and the gate reported both as undeclared runtime deps.
    [/(?:^|;)[ \t]*(?:import|export)\s+[^;()=`]*?\bfrom\s*["']([^"']+)["']/gm, true],
    [/^\s*import\s+["']([^"']+)["']/gm, true],
    [/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, false],
    [/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, false],
  ];
  for (const [re, isStatic] of patterns) {
    for (const m of code.matchAll(re)) found.push({ spec: m[1], isStatic });
  }
  return found;
};

// Normalize "@scope/pkg/deep" -> "@scope/pkg", "pkg/deep" -> "pkg".
// Returns null for relative paths and anything that isn't a valid npm specifier
// (prose inside strings that happens to follow the word "from").
const toModuleName = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  const m = spec.match(/^(@[a-z0-9-~][\w.-]*\/[a-z0-9-~][\w.-]*|[a-z0-9-~][\w.-]*)(\/|$)/);
  return m ? m[1] : null;
};

// BFS the workspace graph from the CLI entry package.
const queue = ['@ethosagent/cli'];
const visited = new Set();
const external = new Map(); // module -> first file seen in
const staticImports = new Map(); // module -> first file importing it statically
while (queue.length > 0) {
  const pkg = queue.shift();
  if (visited.has(pkg)) continue;
  visited.add(pkg);
  const src = srcDirs.get(pkg);
  if (!src) continue;
  for (const file of sourceFiles(src)) {
    for (const { spec, isStatic } of specifiers(file)) {
      const name = toModuleName(spec);
      if (!name || builtins.has(name) || builtins.has(spec)) continue;
      if (name.startsWith('@ethosagent/')) {
        if (!EXTERNAL_WORKSPACE.has(name)) queue.push(name); // bundled — walk into it
      } else {
        if (!external.has(name)) external.set(name, file);
        if (isStatic && !staticImports.has(name)) staticImports.set(name, file);
      }
    }
  }
}

const cliPkg = JSON.parse(readFileSync('apps/ethos/package.json', 'utf8'));
const declared = new Set([
  ...Object.keys(cliPkg.dependencies ?? {}),
  ...Object.keys(cliPkg.optionalDependencies ?? {}),
]);

// An optionalDependency is absent under `npm install --omit=optional`, the lean
// install apps/ethos/README.md recommends. A STATIC import of one is hoisted to
// the top of the bundle, so its absence crashes every command at startup — the
// 0.8.0 grammy/@slack/bolt/discord.js/imapflow/mailparser/nodemailer break. It
// must be loaded with a dynamic `import()` where the feature is built (e.g.
// extensions/platform-telegram/src/sdk.ts); types via `import type`.
const requiredDeps = new Set(Object.keys(cliPkg.dependencies ?? {}));
const optionalOnly = new Set(
  Object.keys(cliPkg.optionalDependencies ?? {}).filter((n) => !requiredDeps.has(n)),
);
const staticOptional = [...staticImports.entries()]
  .filter(([name]) => optionalOnly.has(name))
  .sort(([a], [b]) => a.localeCompare(b));

const missing = [...external.entries()]
  .filter(([name]) => !declared.has(name) && !ALLOWLIST.has(name))
  .sort(([a], [b]) => a.localeCompare(b));

if (staticOptional.length > 0) {
  console.error('BUNDLE-DEPS: optionalDependencies imported STATICALLY by bundled CLI sources:');
  for (const [name, file] of staticOptional) {
    console.error(`  ${name}  (imported in ${file})`);
  }
  console.error('');
  console.error('`npm install --omit=optional` leaves these out, and a static import is hoisted to');
  console.error('the top of dist/index.js, so every ethos command crashes with ERR_MODULE_NOT_FOUND.');
  console.error("Fix: load it with `await import('<pkg>')` where the feature is constructed (see");
  console.error('extensions/platform-telegram/src/sdk.ts) and keep type imports as `import type`.');
}

if (missing.length > 0) {
  console.error('BUNDLE-DEPS: bare modules bundled into the CLI but not declared in');
  console.error('apps/ethos/package.json dependencies/optionalDependencies:');
  for (const [name, file] of missing) {
    console.error(`  ${name}  (imported in ${file})`);
  }
  console.error('');
  console.error('A fresh npm install of @ethosagent/cli will crash with ERR_MODULE_NOT_FOUND.');
  console.error('Fix: add the module (same semver range as the declaring workspace package)');
  console.error('to apps/ethos/package.json, or allowlist it here with a justification.');
  process.exit(1);
}

if (staticOptional.length > 0) process.exit(1);

console.log(
  `All ${external.size} bundled external modules declared (walked ${visited.size} workspace packages).`,
);
EOF
