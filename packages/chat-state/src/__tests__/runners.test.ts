import { describe, expect, it } from 'vitest';
import { RUNNERS, resolveRunner } from '../runners';

// T28 — runner identity is data, not CSS (pi-delegation D19). The CSS half
// (`runnerAccentCss`/`runnerAccentVars`) is pinned in
// apps/web/src/lib/__tests__/runners.test.ts.

describe('RUNNERS identity map', () => {
  it('carries the DESIGN.md runner accent for the coding harness', () => {
    const entry = RUNNERS.pi;
    expect(entry).toBeDefined();
    expect(entry?.accent).toEqual({ dark: '#2DD4BF', light: '#0D9488' });
  });

  it('gives the in-house runner no accent — it is not a foreign process', () => {
    expect(RUNNERS.ethos?.accent).toBeNull();
  });

  it('keeps every runner accent out of the five personality hues', () => {
    // The personality accents from DESIGN.md. A runner reading as an agent's
    // identity is the exact confusion the separate subsection exists to stop.
    const personalityAccents = ['#4A9EFF', '#4ADE80', '#F59E0B', '#E879F9', '#94A3B8'];
    for (const runner of Object.values(RUNNERS)) {
      if (!runner.accent) continue;
      expect(personalityAccents).not.toContain(runner.accent.dark);
      expect(personalityAccents).not.toContain(runner.accent.light);
    }
  });
});

describe('resolveRunner', () => {
  it('resolves a known id to its map entry', () => {
    expect(resolveRunner('pi').badgeText).toBe('PI');
  });

  it('renders an unknown runner rather than blanking the card', () => {
    // T28 — a newer runner on the other side of the RPC is not an error.
    const unknown = resolveRunner('opencode');
    expect(unknown.label).toBe('Opencode');
    expect(unknown.badgeText).toBe('OPENCODE');
    expect(unknown.accent).toBeNull();
  });

  it('survives an empty runner name', () => {
    expect(resolveRunner('').badgeText).toBe('RUN');
  });
});
