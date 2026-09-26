// Phase 3 — the gate that makes ARCHITECTURE.md §IX fail a build.
//
// `scripts/check-architecture.mjs` is the validator §IX declares. This file is
// its thin harness: it runs the real checker against the real repository so a
// boundary violation fails `pnpm test` (and therefore `pnpm check`), and it
// drives the rules that must not depend on the live repository happening to
// exercise them — the §VIII exception shapes and both directions of the
// register↔code tie — against fixtures, so each is proven to have teeth on its
// own terms. The layer rules (vendored shim, app entry modules, core's kernel
// imports) moved to archcheck; their fixtures are archcheck-fixtures/, proven
// by archcheck-fixtures.test.ts.
//
// It lives beside the other constitution drift gates (personality-field-count,
// memory-method-count, agent-event-drift) because it is the same kind of thing:
// a mechanical check on a rule the constitution states in prose.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-architecture.mjs');
const ARCHITECTURE = join(REPO_ROOT, 'ARCHITECTURE.md');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ethos-arch-'));
  tmpDirs.push(dir);
  return dir;
}

/** Run the validator. Returns its exit code and combined output. */
function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync('node', [CHECKER, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A sidecar with the minimum the exception check reads. */
function sidecarWith(exceptions: string): string {
  const dir = scratch();
  writeFileSync(
    join(dir, 'state.yaml'),
    [
      'version: 1',
      'tiers:',
      '  packages/types:',
      '    package: "@ethosagent/types"',
      '    tier: 0',
      '    assigned: 2026-08-12',
      'exceptions:',
      exceptions,
    ].join('\n'),
  );
  return join(dir, 'state.yaml');
}

const WELL_FORMED = [
  '  - id: EX-001',
  '    law: "§III Law 4"',
  '    scope: extensions/tools-web/src/fetch.ts',
  '    reason: "The upstream client has no injectable transport; forking it costs a release."',
  '    owner: a-maintainer',
  '    created: 2026-08-01',
  '    removal_condition: "upstream ships a transport option and the pinned version is >= 3.0.0"',
  '    review_by: 2099-01-01',
].join('\n');

describe('architecture validator — the live repository', () => {
  it('satisfies every mechanically-enforced rule in ARCHITECTURE.md §IX', () => {
    const { code, output } = run([]);
    // The output is the report, not a stack trace: print it verbatim so the
    // contributor who broke a rule reads the remedy rather than an assertion.
    expect(code, `\n${output}`).toBe(0);
  });

  it('refuses to run against a document with no §IX rules block', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'FAKE.md'), '# Nothing here\n\n```yaml\nversion: 1\n```\n');
    const { code, output } = run(['--architecture', join(dir, 'FAKE.md')]);
    expect(code).toBe(2);
    expect(output).toContain('ARCHITECTURE-RULES v1');
  });
});

describe('architecture validator — §VIII exception shapes', () => {
  it('accepts a well-formed, unexpired exception', () => {
    const { code, output } = run(['--only', 'exceptions', '--sidecar', sidecarWith(WELL_FORMED)]);
    expect(code, output).toBe(0);
  });

  const rejected: [string, string, string][] = [
    [
      'a missing required field',
      WELL_FORMED.replace('    owner: a-maintainer\n', ''),
      'missing required field "owner"',
    ],
    [
      'an expired review_by',
      WELL_FORMED.replace('review_by: 2099-01-01', 'review_by: 2020-01-01'),
      'has passed',
    ],
    [
      'an indefinite term',
      WELL_FORMED.replace('review_by: 2099-01-01', 'review_by: "until further notice"'),
      'not an ISO-8601 date',
    ],
    [
      'an unobservable removal condition',
      WELL_FORMED.replace(/removal_condition: ".*"/, 'removal_condition: "best effort"'),
      'not observable',
    ],
    [
      'a §V Safety Constitution carve-out',
      WELL_FORMED.replace('law: "§III Law 4"', 'law: "§V S6 inbound safety injection"'),
      '§V Safety Constitution rule',
    ],
    [
      'a Law 11 kernel-guarantee carve-out',
      WELL_FORMED.replace('law: "§III Law 4"', 'law: "§III Law 11"'),
      'targets Law 11',
    ],
    [
      'a pattern-wide scope',
      WELL_FORMED.replace('scope: extensions/tools-web/src/fetch.ts', 'scope: "extensions/*"'),
      'pattern-wide',
    ],
    [
      'a scope inside a Tier 0 package',
      WELL_FORMED.replace(
        'scope: extensions/tools-web/src/fetch.ts',
        'scope: packages/types/src/safety.ts',
      ),
      'Tier 0',
    ],
  ];

  for (const [name, body, expected] of rejected) {
    it(`rejects ${name}`, () => {
      const { code, output } = run(['--only', 'exceptions', '--sidecar', sidecarWith(body)]);
      expect(code, output).toBe(1);
      expect(output).toContain(expected);
    });
  }
});

describe('architecture validator — register <-> enforcement point (G11)', () => {
  /**
   * A fixture repository: a register citing one live line, one deleted line, and
   * a kernel_path nobody publishes. This is the shape G11 had — a claim whose
   * enforcement point stopped existing — and the shape its converse has.
   *
   * `liveBody` is a parameter so the same register can be pointed at a file
   * whose enforcement point has MOVED rather than been deleted: same line
   * number, still real, still non-blank, now the wrong code.
   */
  function fixtureRepo(opts?: { liveBody?: string[]; anchors?: string[] }): {
    root: string;
    sidecar: string;
  } {
    const root = scratch();
    mkdirSync(join(root, 'docs', 'content', 'security'), { recursive: true });
    mkdirSync(join(root, 'packages', 'kernel', 'src'), { recursive: true });

    writeFileSync(
      join(root, 'packages', 'kernel', 'src', 'live.ts'),
      (opts?.liveBody ?? ['// 1', '// 2', 'export const enforced = true;', '']).join('\n'),
    );
    writeFileSync(join(root, 'packages', 'kernel', 'src', 'moved.ts'), 'export const y = 2;\n');
    writeFileSync(join(root, 'packages', 'kernel', 'src', 'orphan.ts'), 'export const x = 1;\n');

    const blob = 'https://github.com/ethosagent/ethos/blob/main';
    writeFileSync(
      join(root, 'docs', 'content', 'security', 'security-boundary.md'),
      [
        '### G-LIVE — a claim that still resolves',
        `- **Enforced at.** [\`live.ts:3\`](${blob}/packages/kernel/src/live.ts#L3)`,
        '',
        '### G-GONE — a claim whose line was deleted',
        `- **Enforced at.** [\`moved.ts:900\`](${blob}/packages/kernel/src/moved.ts#L900)`,
        '',
      ].join('\n'),
    );

    const sidecar = join(root, 'state.yaml');
    writeFileSync(
      sidecar,
      [
        'version: 1',
        'register_anchors:',
        ...(opts?.anchors ?? [
          '  G-LIVE:',
          '    - { path: packages/kernel/src/live.ts, line: 3, contains: "export const enforced" }',
          '  G-GONE:',
          '    - { path: packages/kernel/src/moved.ts, line: 900, contains: "whatever" }',
        ]),
        'tiers:',
        '  packages/kernel:',
        '    package: "@ethosagent/kernel"',
        '    tier: 0',
        '    assigned: 2026-08-12',
        '    kernel_paths:',
        '      - packages/kernel/src/live.ts',
        '      - packages/kernel/src/moved.ts',
        '      - packages/kernel/src/orphan.ts',
        'exceptions: []',
      ].join('\n'),
    );
    return { root, sidecar };
  }

  function runRegister(root: string, sidecar: string) {
    return run([
      '--only',
      'register',
      '--root',
      root,
      '--architecture',
      ARCHITECTURE,
      '--sidecar',
      sidecar,
    ]);
  }

  it('fails forward on a citation that no longer resolves, and reverse on an unpublished enforcement point', () => {
    const { root, sidecar } = fixtureRepo();
    const { code, output } = runRegister(root, sidecar);
    expect(code, output).toBe(1);
    // Forward: G-GONE cites a line the file does not have.
    expect(output).toContain('G-GONE');
    expect(output).toContain('#L900');
    // Reverse: orphan.ts is kernel with no register row.
    expect(output).toContain('packages/kernel/src/orphan.ts');
    expect(output).toContain('cited by no register row');
    // The row that still resolves is not reported, in either direction.
    expect(output).not.toContain('G-LIVE');
    expect(output).not.toContain('packages/kernel/src/live.ts');
  });

  // The quiet half of G11: the enforcement point did not vanish, it MOVED. The
  // cited line still exists and is not blank, so a line-number-only check passes
  // while the published claim now points at unrelated code.
  it('fails when the cited line still exists but no longer holds the enforcement point', () => {
    const { root, sidecar } = fixtureRepo({
      liveBody: ['// 1', '// 2', '// an inserted comment', 'export const enforced = true;', ''],
    });
    const { code, output } = runRegister(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('G-LIVE');
    expect(output).toContain('export const enforced');
    expect(output).toContain('an inserted comment');
  });

  it('fails on a citation with no anchor, and on an anchor no citation uses', () => {
    const { root, sidecar } = fixtureRepo({
      anchors: [
        '  G-GONE:',
        '    - { path: packages/kernel/src/moved.ts, line: 900, contains: "whatever" }',
        '  G-STALE:',
        '    - { path: packages/kernel/src/live.ts, line: 3, contains: "export const enforced" }',
      ],
    });
    const { code, output } = runRegister(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('no anchor in register_anchors');
    expect(output).toContain('which no citation in the register uses');
  });

  it('fails on an anchor that asserts nothing', () => {
    const { root, sidecar } = fixtureRepo({
      anchors: [
        '  G-LIVE:',
        '    - { path: packages/kernel/src/live.ts, line: 3, contains: "" }',
        '  G-GONE:',
        '    - { path: packages/kernel/src/moved.ts, line: 900, contains: "whatever" }',
      ],
    });
    const { code, output } = runRegister(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('empty "contains"');
  });
});

describe('architecture validator — claims made ABOUT the register', () => {
  /**
   * The prose half of G11. Check 3 ties every claim IN the register to code;
   * this one ties the claims ABOUT the register — its size and its membership,
   * asserted in SECURITY.md and README.md — back to the register itself. The
   * drift it exists to catch is the one that actually happened: two rows were
   * added and both documents went on saying "ten".
   *
   * Each fixture is a repository with a register of `### G-…` rows and the two
   * documents that claim things about it, so every case is proven on its own
   * terms rather than on the live repo happening to exercise it.
   */
  function claimFixture(opts?: { rows?: string[]; security?: string[]; readme?: string[] }): {
    root: string;
    sidecar: string;
  } {
    const root = scratch();
    mkdirSync(join(root, 'docs', 'content', 'security'), { recursive: true });

    const rows = opts?.rows ?? ['G-ONE', 'G-TWO', 'G-THREE'];
    writeFileSync(
      join(root, 'docs', 'content', 'security', 'security-boundary.md'),
      rows
        .map((id) => `### ${id} — a guarantee {#${id.toLowerCase()}}\n\n- **Claim.** Something.\n`)
        .join('\n'),
    );

    writeFileSync(
      join(root, 'SECURITY.md'),
      (
        opts?.security ?? [
          '# Security policy',
          '',
          '<!-- register-claim',
          '     ids: G-ONE, G-TWO, G-THREE',
          '-->',
          '- **The guarantee register** — three named guarantees, each with the `file:line` that enforces it.',
          '- **The tier roster** — 119 packages: 10 at Tier 0, 25 at Tier 1.',
          '',
        ]
      ).join('\n'),
    );

    writeFileSync(
      join(root, 'README.md'),
      (
        opts?.readme ?? [
          '## The security boundary',
          '',
          '<!-- register-claim',
          '     ids:   G-ONE, G-TWO, G-THREE',
          '     names: alpha, beta, gamma',
          '-->',
          'Ethos publishes a closed list of three security guarantees — alpha, beta, and gamma — each',
          'naming the line that enforces it.',
          '',
        ]
      ).join('\n'),
    );

    const sidecar = join(root, 'state.yaml');
    writeFileSync(sidecar, ['version: 1', 'tiers: {}', 'exceptions: []'].join('\n'));
    return { root, sidecar };
  }

  const runClaims = (root: string, sidecar: string) =>
    run([
      '--only',
      'register-claims',
      '--root',
      root,
      '--architecture',
      ARCHITECTURE,
      '--sidecar',
      sidecar,
    ]);

  it('accepts documents whose marker and prose both match the register', () => {
    const { root, sidecar } = claimFixture();
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(0);
  });

  // The failure verbatim: the register grew, the citing documents did not.
  it('fails both citing documents when the register gains a row', () => {
    const { root, sidecar } = claimFixture({ rows: ['G-ONE', 'G-TWO', 'G-THREE', 'G-FOUR'] });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('SECURITY.md');
    expect(output).toContain('README.md');
    expect(output).toContain('missing G-FOUR');
  });

  // A marker alone would let the prose rot beside it — the same bug, one layer
  // down. Here the markers track the register and only the sentences are stale.
  it('fails when the marker tracks the register but the prose beside it does not', () => {
    const { root, sidecar } = claimFixture({
      rows: ['G-ONE', 'G-TWO', 'G-THREE', 'G-FOUR'],
      security: [
        '<!-- register-claim',
        '     ids: G-ONE, G-TWO, G-THREE, G-FOUR',
        '-->',
        '- **The guarantee register** — three named guarantees.',
        '',
      ],
      readme: [
        '<!-- register-claim',
        '     ids:   G-ONE, G-TWO, G-THREE, G-FOUR',
        '     names: alpha, beta, gamma, delta',
        '-->',
        'A closed list of four security guarantees — alpha, beta, gamma, and delta.',
        '',
      ],
    });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('SECURITY.md');
    expect(output).toContain('never says "four"');
    // README is correct in both halves and must not be reported.
    expect(output).not.toContain('README.md');
  });

  it("fails a marker whose ids are the register's rows in the wrong order", () => {
    const { root, sidecar } = claimFixture({
      security: [
        '<!-- register-claim',
        '     ids: G-THREE, G-TWO, G-ONE',
        '-->',
        '- **The guarantee register** — three named guarantees.',
        '',
      ],
    });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('same rows, wrong order');
  });

  it('fails a required document that carries no marker at all', () => {
    const { root, sidecar } = claimFixture({
      readme: ['## The security boundary', '', 'A closed list of three security guarantees.', ''],
    });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('README.md');
    expect(output).toContain('carries no `<!-- register-claim');
  });

  // The membership half: the marker pairs a name to every row, so a row added
  // without its phrase reaching the enumeration is a finding, not a silence.
  it('fails when the enumeration omits a guarantee the marker pairs to a row', () => {
    const { root, sidecar } = claimFixture({
      readme: [
        '<!-- register-claim',
        '     ids:   G-ONE, G-TWO, G-THREE',
        '     names: alpha, beta, gamma',
        '-->',
        'A closed list of three security guarantees — alpha and beta.',
        '',
      ],
    });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('never names "gamma"');
  });

  it('fails a marker that pairs a different number of names and ids', () => {
    const { root, sidecar } = claimFixture({
      readme: [
        '<!-- register-claim',
        '     ids:   G-ONE, G-TWO, G-THREE',
        '     names: alpha, beta',
        '-->',
        'A closed list of three security guarantees — alpha and beta.',
        '',
      ],
    });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('pairs 3 ids with 2 names');
  });

  // The claim is the block the marker sits on, not everything after it. A "10"
  // in the NEXT bullet is a different sentence about a different thing, and
  // must not satisfy a count claim the marker's own sentence never makes.
  it('does not accept a count that appears only in the following block', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `G-R${'ABCDEFGHIJ'[i]}`);
    const { root, sidecar } = claimFixture({
      rows,
      security: [
        '<!-- register-claim',
        `     ids: ${rows.join(', ')}`,
        '-->',
        '- **The guarantee register** — the named guarantees, each with the line that enforces it.',
        '- **The tier roster** — 119 packages: 10 at Tier 0.',
        '',
      ],
    });
    const { code, output } = runClaims(root, sidecar);
    expect(code, output).toBe(1);
    expect(output).toContain('never says "ten"');
  });
});
