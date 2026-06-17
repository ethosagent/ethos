import type { LearningLogEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  applyExpressionUpdate,
  parseLivingSoul,
  revertExpression,
  serializeLivingSoul,
} from '../living-soul';

const SECTIONED = `# Core
I am the engineer. I value precision.
<!-- core is immutable -->

# Expression
I speak tersely and prefer code over prose.

# Learning Log
- 2026-06-01T00:00:00.000Z · expr-rev-1 · "softened greetings" · evidence: ev-1 · prev: snap-0
`;

const FLAT = `I am a legacy soul with no headers.
I speak however I always have.
`;

function entry(overrides: Partial<LearningLogEntry> = {}): LearningLogEntry {
  return {
    revisionId: 'expr-rev-7',
    at: '2026-06-17T12:00:00.000Z',
    summary: 'tightened tone',
    evidenceRef: 'ev-42',
    prevExpressionRef: 'snap-6',
    ...overrides,
  };
}

describe('parseLivingSoul — grammar rules', () => {
  it('flat (no headers) → whole body is core', () => {
    const soul = parseLivingSoul(FLAT);
    expect(soul.core).toBe(FLAT);
    expect(soul.expression).toBe('');
    expect(soul.learningLog).toEqual([]);
  });

  it('# Core present, # Expression absent → whole body is core', () => {
    const body = '# Core\nI am core only.\n';
    const soul = parseLivingSoul(body);
    expect(soul.core).toBe(body);
    expect(soul.expression).toBe('');
  });

  it('# Expression present without # Core → flat (whole body is core)', () => {
    const body = '# Expression\nI speak.\n';
    const soul = parseLivingSoul(body);
    expect(soul.core).toBe(body);
    expect(soul.expression).toBe('');
    expect(soul.learningLog).toEqual([]);
  });

  it('typo header (# Expresion) is not recognized → falls into Core', () => {
    const body = '# Core\nReal core.\n# Expresion\nNot a real expression.\n';
    const soul = parseLivingSoul(body);
    // No recognized # Expression → flat → whole body is core.
    expect(soul.core).toBe(body);
    expect(soul.expression).toBe('');
  });
});

describe('round-trip byte-identity of Core', () => {
  it('sectioned fixture: parse(serialize(parse(x))).core === parse(x).core', () => {
    const first = parseLivingSoul(SECTIONED);
    const round = parseLivingSoul(serializeLivingSoul(first));
    expect(round.core).toBe(first.core);
    expect(round.expression).toBe(first.expression);
    // Full sectioned fixture round-trips byte-identically.
    expect(serializeLivingSoul(first)).toBe(SECTIONED);
  });

  it('flat fixture: core round-trips and serialize equals the original bytes', () => {
    const first = parseLivingSoul(FLAT);
    const round = parseLivingSoul(serializeLivingSoul(first));
    expect(round.core).toBe(first.core);
    expect(serializeLivingSoul(first)).toBe(FLAT);
  });
});

describe('applyExpressionUpdate', () => {
  for (const [label, body] of [
    ['sectioned', SECTIONED],
    ['flat', FLAT],
  ] as const) {
    it(`${label}: keeps Core byte-identical, appends one log entry, swaps Expression`, () => {
      const before = parseLivingSoul(body);
      const newExpr = 'I now speak with measured warmth.\n';
      const e = entry();
      const result = applyExpressionUpdate(body, newExpr, e);
      const after = parseLivingSoul(result);

      // Core bytes round-trip.
      expect(after.core).toBe(before.core);

      // Learning log gained exactly one entry, which round-trips.
      expect(after.learningLog.length).toBe(before.learningLog.length + 1);
      const appended = after.learningLog[after.learningLog.length - 1];
      expect(appended).toEqual(e);

      // Expression changed.
      expect(after.expression).toBe(newExpr);
      expect(after.expression).not.toBe(before.expression);
    });
  }
});

describe('revertExpression', () => {
  it('restores a prior Expression, keeps Core, appends one log entry', () => {
    const before = parseLivingSoul(SECTIONED);
    const restore = 'I speak as I once did.\n';
    const e = entry({ revisionId: 'expr-rev-8', summary: 'reverted' });
    const result = revertExpression(SECTIONED, restore, e);
    const after = parseLivingSoul(result);

    expect(after.expression).toBe(restore);
    expect(after.core).toBe(before.core);
    expect(after.learningLog.length).toBe(before.learningLog.length + 1);
    expect(after.learningLog[after.learningLog.length - 1]).toEqual(e);
  });
});

describe('Learning Log round-trip (multi-entry)', () => {
  it('parse → serialize → parse preserves all entry fields', () => {
    const e1 = entry({ revisionId: 'expr-rev-1', summary: 'first', evidenceRef: 'ev-a' });
    const e2 = entry({ revisionId: 'expr-rev-2', summary: 'second', prevExpressionRef: 'snap-1' });
    const seeded = applyExpressionUpdate(
      applyExpressionUpdate(SECTIONED, 'expr A\n', e1),
      'expr B\n',
      e2,
    );
    const parsed = parseLivingSoul(seeded);
    const reparsed = parseLivingSoul(serializeLivingSoul(parsed));
    expect(reparsed.learningLog).toEqual(parsed.learningLog);
    // Three entries total: the fixture's seed plus the two we added.
    expect(reparsed.learningLog.length).toBe(3);
  });
});
