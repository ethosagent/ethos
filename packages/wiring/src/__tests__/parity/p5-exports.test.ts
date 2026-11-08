// P5 — export surface of every workspace package, read with the TypeScript compiler
// API over the root tsconfig (so `@ethosagent/*` imports resolve to source). Records
// `name -> value | type | namespace` per package entry.
//
// The published packages are the ones without `"private": true`. For those,
// `UPDATE_PARITY=1` THROWS rather than drop a name (`assertNoPublishedDrops`): removing
// a public name needs a hand edit of the fixture in a PR that carries the deprecation
// decision (plan codebase-slimming §9 Q5).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { assertParity, REPO_ROOT } from './harness';

/** The published packages per plan §2.4 P5; asserted equal to "not private" below. */
const PUBLISHED = [
  '@ethosagent/types',
  '@ethosagent/core',
  '@ethosagent/plugin-sdk',
  '@ethosagent/plugin-contract',
  '@ethosagent/sdk',
  '@ethosagent/web-contracts',
  '@ethosagent/cli',
];

/** Extra subpath entries (plan: plugin-sdk's `./tool-helpers` and `./testing`). */
const SUBPATH_ENTRIES: Record<string, string[]> = {
  '@ethosagent/plugin-sdk': ['tool-helpers', 'testing'],
};

type Kind = 'value' | 'type' | 'namespace' | 'unknown';
interface EntryExports {
  entry: string;
  exports: Record<string, Kind>;
}
type Surface = Record<string, EntryExports>;

interface WorkspacePackage {
  name: string;
  dir: string;
  private: boolean;
}

/** Package directories named by `pnpm-workspace.yaml`: `x/*` globs and literal paths. */
function workspaceDirs(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^packages:\n((?:[ \t]+-.*\n?)+)/m.exec(text)?.[1];
  if (!block) throw new Error('pnpm-workspace.yaml has no packages: list');
  const dirs: string[] = [];
  for (const line of block.split('\n')) {
    const pattern = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(line)?.[1];
    if (!pattern) continue;
    if (pattern.endsWith('/*')) {
      const root = pattern.slice(0, -2);
      if (!existsSync(join(REPO_ROOT, root))) continue;
      for (const d of readdirSync(join(REPO_ROOT, root)).sort()) dirs.push(`${root}/${d}`);
    } else {
      dirs.push(pattern);
    }
  }
  return dirs;
}

function workspacePackages(): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const dir of workspaceDirs()) {
    const pj = join(REPO_ROOT, dir, 'package.json');
    if (!existsSync(pj)) continue;
    const json = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; private?: boolean };
    if (json.name) out.push({ name: json.name, dir, private: json.private === true });
  }
  return out;
}

function entriesOf(pkg: WorkspacePackage): Array<{ key: string; file: string }> {
  const found: Array<{ key: string; file: string }> = [];
  const index = ['ts', 'tsx']
    .map((ext) => `${pkg.dir}/src/index.${ext}`)
    .find((file) => existsSync(join(REPO_ROOT, file)));
  if (index) found.push({ key: pkg.name, file: index });
  // A published package with no source entry would silently fall out of the surface.
  else if (!pkg.private) throw new Error(`published package ${pkg.name} has no src/index.ts(x)`);
  for (const sub of SUBPATH_ENTRIES[pkg.name] ?? []) {
    found.push({ key: `${pkg.name}/${sub}`, file: `${pkg.dir}/src/${sub}.ts` });
  }
  return found;
}

function kindOf(checker: ts.TypeChecker, symbol: ts.Symbol): Kind {
  let target = symbol;
  if (target.flags & ts.SymbolFlags.Alias) {
    try {
      target = checker.getAliasedSymbol(target);
    } catch {
      return 'unknown';
    }
  }
  if (target.flags & ts.SymbolFlags.Value) {
    // A namespace-only module symbol is flagged ValueModule; call it a namespace.
    const nsOnly =
      target.flags & ts.SymbolFlags.ValueModule &&
      !(
        target.flags &
        (ts.SymbolFlags.Variable |
          ts.SymbolFlags.Function |
          ts.SymbolFlags.Class |
          ts.SymbolFlags.Enum)
      );
    return nsOnly ? 'namespace' : 'value';
  }
  if (target.flags & ts.SymbolFlags.Type) return 'type';
  if (target.flags & ts.SymbolFlags.Namespace) return 'namespace';
  return 'unknown';
}

function readOptions(): ts.CompilerOptions {
  const configPath = join(REPO_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
  };
}

function exportSurface(): Surface {
  const wanted = workspacePackages().flatMap((pkg) => entriesOf(pkg));
  const program = ts.createProgram(
    wanted.map((e) => join(REPO_ROOT, e.file)),
    readOptions(),
  );
  const checker = program.getTypeChecker();
  const surface: Surface = {};
  for (const { key, file } of wanted) {
    const sf = program.getSourceFile(join(REPO_ROOT, file));
    if (!sf) throw new Error(`entry not in program: ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exports: Record<string, Kind> = {};
    if (moduleSymbol) {
      for (const sym of checker.getExportsOfModule(moduleSymbol)) {
        exports[sym.getName()] = kindOf(checker, sym);
      }
    }
    surface[key] = { entry: file, exports };
  }
  return surface;
}

/**
 * Throws when `next` lacks a package, or a name, that `existing` has for a published
 * package. Pure, so the refusal itself is pinned below.
 */
export function assertNoPublishedDrops(
  existing: unknown,
  next: unknown,
  published: string[],
): void {
  const before = existing as Surface;
  const after = next as Surface;
  const dropped: string[] = [];
  for (const [key, entry] of Object.entries(before)) {
    const pkgName = published.find((p) => key === p || key.startsWith(`${p}/`));
    if (!pkgName) continue;
    const now = after[key];
    if (!now) {
      dropped.push(`${key} (whole entry)`);
      continue;
    }
    for (const name of Object.keys(entry.exports)) {
      if (!(name in now.exports)) dropped.push(`${key}: ${name}`);
    }
  }
  if (dropped.length > 0) {
    throw new Error(
      `UPDATE_PARITY refuses to drop public names from published packages:\n  ${dropped.join('\n  ')}\n` +
        'Removing a public name needs a hand edit of golden/p5-exports.json in a PR that carries the deprecation decision.',
    );
  }
}

describe('P5 export surface parity', () => {
  it('the published set is exactly the non-private packages', () => {
    const nonPrivate = workspacePackages()
      .filter((p) => !p.private)
      .map((p) => p.name)
      .sort();
    expect(nonPrivate).toEqual([...PUBLISHED].sort());
  });

  it('refuses to drop a published name, allows dropping a private one', () => {
    const existing = {
      '@ethosagent/types': { entry: 'x', exports: { A: 'type', B: 'value' } },
      '@ethosagent/plugin-sdk/testing': { entry: 'y', exports: { T: 'value' } },
      '@ethosagent/gateway': { entry: 'z', exports: { G: 'value' } },
    };
    const dropPrivate = { ...existing, '@ethosagent/gateway': { entry: 'z', exports: {} } };
    expect(() => assertNoPublishedDrops(existing, dropPrivate, PUBLISHED)).not.toThrow();
    const dropName = { ...existing, '@ethosagent/types': { entry: 'x', exports: { A: 'type' } } };
    expect(() => assertNoPublishedDrops(existing, dropName, PUBLISHED)).toThrow(/types: B/);
    const { '@ethosagent/plugin-sdk/testing': _gone, ...dropEntry } = existing;
    expect(() => assertNoPublishedDrops(existing, dropEntry, PUBLISHED)).toThrow(
      /plugin-sdk\/testing/,
    );
    // Adding names is always fine.
    const add = {
      ...existing,
      '@ethosagent/types': { entry: 'x', exports: { A: 'type', B: 'value', C: 'value' } },
    };
    expect(() => assertNoPublishedDrops(existing, add, PUBLISHED)).not.toThrow();
  });

  it('matches the export-surface fixture', () => {
    assertParity('p5-exports', exportSurface(), {
      guardUpdate: (existing, next) => assertNoPublishedDrops(existing, next, PUBLISHED),
      requireExistingFixture: true,
    });
  }, 600_000);
});
