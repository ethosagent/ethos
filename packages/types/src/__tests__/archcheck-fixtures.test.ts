// The archcheck fixture harness — proof that every error rule in architecture.config.ts has teeth.
//
// A rule whose pattern matches nothing passes every build and looks exactly like compliance.
// `every-error-rule-has-a-fixture` (architecture.config.ts) only demands that
// `archcheck-fixtures/<id>.violation.ts` EXISTS; this file is what proves each one is caught.
//
// Mechanism (mirrors archcheck's own tests/fixtures.test.ts): each fixture's first line is a
// directive, `// archcheck-fixture: place-at <path>`. The harness builds a scratch root holding
// the real architecture.config.ts, a copy of archcheck-fixtures/ (so the fixture obligation is
// satisfied), a tsconfig covering the placed files, and three stub import targets (one each in
// the core, extensions and wiring layers) for the layers fixtures to cross into. It runs archcheck
// ONCE through its API and asserts every placed file is reported by exactly its own rule, and
// that nothing else in the scratch tree is reported at all. The one fixture that cannot be
// placed — the obligation itself — says `verified-by "<test name>"`, and that test removes a
// fixture from a scratch copy and asserts the obligation fires.
//
// The fixtures live outside the root tsconfig include, so the real `pnpm typecheck` and the real
// archcheck run never see them.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Diagnostic, load, type Rule } from 'archcheck';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'archcheck-fixtures');
const OBLIGATION = 'every-error-rule-has-a-fixture';
const OBLIGATION_TEST = 'the fixture obligation fires when a fixture is missing';

type Directive = { kind: 'place-at'; path: string } | { kind: 'verified-by'; test: string };

const DIRECTIVE = /^\/\/ archcheck-fixture:\s*(place-at|verified-by)\s+(.+)$/m;

function fixtureFiles(): { ruleId: string; source: string; directive: Directive }[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.violation.ts'))
    .sort()
    .map((name) => {
      const source = readFileSync(join(FIXTURES, name), 'utf8');
      const match = DIRECTIVE.exec(source);
      if (!match) throw new Error(`${name} has no archcheck-fixture directive`);
      const value = (match[2] ?? '').trim();
      const directive: Directive =
        match[1] === 'verified-by'
          ? { kind: 'verified-by', test: value.replace(/^"|"$/g, '') }
          : { kind: 'place-at', path: value };
      return { ruleId: name.replace('.violation.ts', ''), source, directive };
    });
}

// The layers fixtures import these. Each sits in a layer the importing fixture may not reach,
// and none of them is reported itself (asserted below).
const STUBS: Record<string, string> = {
  'packages/core/src/archcheck-target.ts': 'export const coreTarget = 1;\n',
  'extensions/archcheck-target/src/index.ts': 'export const extensionTarget = 1;\n',
  'packages/wiring/src/archcheck-target.ts': 'export const wiringTarget = 1;\n',
};

const SCRATCH_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['packages/**/*', 'extensions/**/*', 'apps/**/*', 'plugins/**/*'],
};

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch root with the manifest, the fixture folder, the stubs and every fixture placed. */
function scratchWithFixturesPlaced(): { root: string; placed: Map<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'ethos-archcheck-fixtures-'));
  tmpDirs.push(root);
  cpSync(join(REPO_ROOT, 'architecture.config.ts'), join(root, 'architecture.config.ts'));
  cpSync(FIXTURES, join(root, 'archcheck-fixtures'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(SCRATCH_TSCONFIG, null, 2));
  const place = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  for (const [path, source] of Object.entries(STUBS)) place(path, source);
  const placed = new Map<string, string>();
  for (const { ruleId, source, directive } of fixtureFiles()) {
    if (directive.kind !== 'place-at') continue;
    place(directive.path, source);
    placed.set(ruleId, directive.path);
  }
  return { root, placed };
}

async function diagnosticsIn(root: string) {
  const loaded = load({ cwd: root });
  if (!loaded.ok)
    throw new Error(`archcheck could not load the scratch root:\n${loaded.error.join('\n')}`);
  const run = await loaded.value.check({ baselined: new Set(), cache: false });
  if (!run.ok) throw new Error(`archcheck run failed:\n${run.error.join('\n')}`);
  return run.value.diagnostics;
}

/** The same derivation archcheck's required-file makes: a `'*'` layers rule can never fire. */
function needsFixture(rule: Rule): boolean {
  if (rule.severity !== 'error') return false;
  if (rule.kind !== 'layers') return true;
  const params = rule.params as { mayImport?: unknown; catchesUnlayered?: boolean };
  return params.catchesUnlayered === true || params.mayImport !== '*';
}

function manifestRules(): readonly Rule[] {
  const loaded = load({ cwd: REPO_ROOT });
  if (!loaded.ok) throw new Error(loaded.error.join('\n'));
  return loaded.value.registry.all();
}

describe('the archcheck fixture suite is complete and honest', () => {
  it('every error rule that can fire has a fixture, and no fixture names an unknown rule', () => {
    const rules = manifestRules();
    const present = new Set(fixtureFiles().map((f) => f.ruleId));
    const missing = rules
      .filter(needsFixture)
      .map((r) => r.id)
      .filter((id) => !present.has(id));
    const known = new Set(rules.map((r) => r.id));
    const orphans = [...present].filter((id) => !known.has(id));
    expect({ missing, orphans }).toEqual({ missing: [], orphans: [] });
  });

  it('exactly one fixture escapes placement, and it names the test that proves it', () => {
    const escapes = fixtureFiles().filter((f) => f.directive.kind === 'verified-by');
    expect(escapes.map((f) => f.ruleId)).toEqual([OBLIGATION]);
    expect(escapes[0]?.directive).toEqual({ kind: 'verified-by', test: OBLIGATION_TEST });
  });
});

describe('each archcheck fixture is caught by exactly its own rule', () => {
  // Placement is synchronous so the per-fixture test names exist at collection time; the one
  // archcheck run over the scratch tree happens in beforeAll.
  const { root, placed } = scratchWithFixturesPlaced();
  let diagnostics: Diagnostic[] = [];
  beforeAll(async () => {
    diagnostics = await diagnosticsIn(root);
  }, 60_000);

  for (const [ruleId, path] of [...placed.entries()].sort()) {
    it(`${ruleId} — and only ${ruleId} — fires for ${path}`, () => {
      const caught = [...new Set(diagnostics.filter((d) => d.file === path).map((d) => d.ruleId))];
      expect(caught).toEqual([ruleId]);
    });
  }

  it('nothing outside the placed fixtures is reported (stubs and manifest are clean)', () => {
    const placedPaths = new Set(placed.values());
    const stray = diagnostics
      .filter((d) => !placedPaths.has(d.file))
      .map((d) => `${d.ruleId} ${d.file}`);
    expect(stray).toEqual([]);
  });
});

describe(OBLIGATION_TEST, () => {
  it('removing a fixture reports every-error-rule-has-a-fixture, naming the rule and the path', async () => {
    const { root } = scratchWithFixturesPlaced();
    rmSync(join(root, 'archcheck-fixtures', 'no-empty-catch.violation.ts'));
    const diagnostics = await diagnosticsIn(root);
    const obligation = diagnostics.filter((d) => d.ruleId === OBLIGATION);
    expect(obligation).toHaveLength(1);
    expect(obligation[0]?.evidence).toMatchObject({
      subject: 'no-empty-catch',
      expected: 'archcheck-fixtures/no-empty-catch.violation.ts',
    });
  }, 60_000);
});
