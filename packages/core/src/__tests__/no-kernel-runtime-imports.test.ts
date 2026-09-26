// Mechanical gate for ARCHITECTURE.md §III Law 2 and the §II security-kernel layer: core reaches
// the security kernel through contract TYPES only. `import type` / `export type` from a kernel
// package is legal (erased at compile time); any runtime import — static `import … from`,
// `export … from`, side-effect `import '…'`, dynamic `import('…')`, `require('…')` — is not.
// A kernel core could import directly would make the engine unswappable and the kernel
// unreplaceable.
//
// Why this is a vitest scan and not an archcheck rule: archcheck's `ignoreTypeOnly` is set per
// SOURCE layer, not per (source, target) edge, so `l2-core-no-concrete` in architecture.config.ts
// has to allow every core → security-kernel edge to keep the legal type imports passing. The old
// `layers` check in scripts/check-architecture.mjs caught runtime imports and was removed when
// archcheck took over layers; this test closes that gap.
//
// The kernel set is not restated here: it is the `security-kernel` layer's `match` globs in
// architecture.config.ts, resolved to directories and then to the `name` in each package.json.
//
// Failure means a file under packages/core/src (tests excluded) imports a kernel package at
// runtime. Change it to `import type`, or receive the capability through AgentLoopConfig /
// a contract in @ethosagent/types bound by wiring.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CORE_SRC = join(REPO_ROOT, 'packages', 'core', 'src');

/** The `security-kernel` layer's `match` globs, read from architecture.config.ts. */
function kernelGlobs(): string[] {
  const manifest = readFileSync(join(REPO_ROOT, 'architecture.config.ts'), 'utf8');
  const block = manifest.match(/name:\s*'security-kernel',\s*match:\s*\[([^\]]*)\]/);
  if (!block?.[1]) throw new Error('architecture.config.ts: no security-kernel layer match found');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

/** Resolve `packages/safety/*\/src/**`-shaped globs to package directories (one `*` segment). */
function kernelPackageDirs(globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    const pkg = glob.replace(/\/src\/\*\*$/, '');
    if (pkg === glob) throw new Error(`unsupported security-kernel glob shape: ${glob}`);
    const star = pkg.indexOf('*');
    if (star === -1) {
      dirs.push(pkg);
      continue;
    }
    const parent = pkg.slice(0, star).replace(/\/$/, '');
    if (pkg.slice(star) !== '*') throw new Error(`unsupported security-kernel glob shape: ${glob}`);
    for (const entry of readdirSync(join(REPO_ROOT, parent))) {
      if (existsSync(join(REPO_ROOT, parent, entry, 'package.json'))) {
        dirs.push(`${parent}/${entry}`);
      }
    }
  }
  return dirs;
}

function kernelPackageNames(): string[] {
  return kernelPackageDirs(kernelGlobs()).map((dir) => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    if (!pkg.name) throw new Error(`${dir}/package.json has no name`);
    return pkg.name;
  });
}

// Remove `//` and `/* */` comments so prose naming a kernel package is not read as an import.
// A character scanner, not a regex, so `//` inside a string ("https://…") survives; line
// structure is kept so reported line numbers match the file. Same approach, and the same known
// limitation (regex literals containing a quote), as stripComments in scripts/check-bundle-deps.sh.
function stripComments(code: string): string {
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
        if (code[i] === '\n') out += '\n';
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
          out += code.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += s;
        i++;
        if (s === c) break;
        if (s === '\n' && c !== '`') break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const keepNewlines = (text: string): string => text.replace(/[^\n]/g, ' ');

// Type-only statements are erased by the compiler, so they are blanked before matching.
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;'"`]*?\bfrom\s*(['"])[^'"\n]+\1/g;

const RUNTIME_PATTERNS: RegExp[] = [
  // `import … from '…'` / `export … from '…'` (multi-line clauses included).
  /\b(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  // side-effect `import '…'`
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  // dynamic `import('…')`
  /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  // `require('…')`, including `import x = require('…')`
  /\brequire\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
];

interface Hit {
  line: number;
  specifier: string;
}

/** Runtime imports of any `kernel` package (or its subpaths) in one source text. */
function runtimeKernelImports(source: string, kernel: readonly string[]): Hit[] {
  const code = stripComments(source).replace(TYPE_ONLY, keepNewlines);
  const hits: Hit[] = [];
  const seen = new Set<number>();
  for (const pattern of RUNTIME_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      const specifier = m[2] ?? '';
      if (!kernel.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) continue;
      const index = (m.index ?? 0) + m[0].lastIndexOf(specifier);
      if (seen.has(index)) continue;
      seen.add(index);
      hits.push({ line: code.slice(0, index).split('\n').length, specifier });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function* coreSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
      yield* coreSourceFiles(abs);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield abs;
    }
  }
}

describe('Law 2 — core does not runtime-import the security kernel', () => {
  const kernel = kernelPackageNames();

  it('resolves the kernel set from architecture.config.ts', () => {
    expect(kernel).toContain('@ethosagent/storage-fs');
    expect(kernel).toContain('@ethosagent/safety-network');
  });

  it('packages/core/src has no runtime import of a kernel package', () => {
    const violations: string[] = [];
    for (const file of coreSourceFiles(CORE_SRC)) {
      for (const hit of runtimeKernelImports(readFileSync(file, 'utf8'), kernel)) {
        violations.push(`${relative(REPO_ROOT, file)}:${hit.line}  ${hit.specifier}`);
      }
    }
    expect(violations, `runtime kernel imports in core:\n${violations.join('\n')}`).toEqual([]);
  });

  describe('matcher has teeth', () => {
    const K = ['@ethosagent/safety-network', '@ethosagent/storage-fs'];

    it('flags every runtime import form, including subpaths', () => {
      const src = [
        "import { safeFetch } from '@ethosagent/safety-network';",
        'export { FsStorage } from "@ethosagent/storage-fs";',
        "import '@ethosagent/storage-fs/side-effect';",
        "const m = await import('@ethosagent/safety-network');",
        "const r = require('@ethosagent/storage-fs');",
        'import {',
        '  type NetworkPolicy,',
        '  safeFetch as f,',
        "} from '@ethosagent/safety-network';",
      ].join('\n');
      expect(runtimeKernelImports(src, K).map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 9]);
    });

    it('allows type-only imports and exports, comments and non-kernel packages', () => {
      const src = [
        "import type { NetworkPolicy } from '@ethosagent/safety-network';",
        'export type {',
        '  Storage,',
        "} from '@ethosagent/storage-fs';",
        "// import { safeFetch } from '@ethosagent/safety-network';",
        "/* require('@ethosagent/storage-fs') */",
        "import { Tool } from '@ethosagent/types';",
        "import { x } from '@ethosagent/safety-networking';",
      ].join('\n');
      expect(runtimeKernelImports(src, K)).toEqual([]);
    });
  });
});
