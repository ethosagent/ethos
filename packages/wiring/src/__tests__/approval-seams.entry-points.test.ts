import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('entry-point wiring', () => {
  // The regression this guards: all three surfaces used to call
  // `createDangerPredicate()` with no arguments, which pinned every
  // personality to `manual` and made `denyRules` / `approvalMode` inert.
  const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
  const ENTRY_POINTS = [
    'apps/ethos/src/commands/serve.ts',
    'apps/ethos/src/commands/gateway.ts',
    'apps/desktop/src/main/serve.ts',
  ];

  // `ethos serve` keeps its entry point in commands/serve.ts but its seams in
  // modules split out of it, so its "source" is all of them: serve.ts, every
  // serve-*.ts and _shared.ts. That is a superset of SERVE_SOURCE_FILES in
  // apps/ethos/src/commands/__tests__/serve-sources.ts (the apps-side list; a
  // wiring test does not import from apps).
  const readEntry = (relPath: string): string => {
    if (relPath !== 'apps/ethos/src/commands/serve.ts') {
      return readFileSync(join(ROOT, relPath), 'utf-8');
    }
    const dir = join(ROOT, 'apps/ethos/src/commands');
    return [
      'serve.ts',
      ...readdirSync(dir)
        .filter((f) => /^serve-.+\.ts$/.test(f))
        .sort(),
      '_shared.ts',
    ]
      .map((f) => readFileSync(join(dir, f), 'utf-8'))
      .join('\n');
  };

  it.each(ENTRY_POINTS)('%s builds its danger predicate with the seams', (relPath) => {
    const src = readEntry(relPath);
    expect(src).toContain('createApprovalDangerPredicate({');
    expect(src).not.toMatch(/createDangerPredicate\(\s*\)/);
  });

  // Every surface that CAN prompt must flag the always-ask set. Checked at the
  // source because the value only matters at the construction site — a predicate
  // built without it is silently ungated, with no runtime signal.
  it.each(ENTRY_POINTS)('%s passes APPROVAL_SURFACE_ALWAYS_ASK', (relPath) => {
    const src = readEntry(relPath);
    expect(src).toContain('alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK');
  });
});
