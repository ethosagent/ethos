import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNERS, resolveRunner } from '@ethosagent/chat-state';
import { describe, expect, it } from 'vitest';
import { runnerAccentCss, runnerAccentVars } from '../runners';

// T28 — the CSS half of runner identity (pi-delegation D19). The map itself
// lives in `@ethosagent/chat-state` (packages/chat-state/src/runners.ts), so no
// file under apps/web/src carries a runner hex at all.

const SRC = join(import.meta.dirname, '..', '..');

describe('accent consumption', () => {
  it('picks the light column on a light surface', () => {
    const runner = resolveRunner('pi');
    expect(runnerAccentCss(runner, true)).toBe('#0D9488');
    expect(runnerAccentCss(runner, false)).toBe('#2DD4BF');
  });

  it('falls back to a token, never a literal, when a runner has no accent', () => {
    expect(runnerAccentCss(resolveRunner('ethos'), false)).toBe('var(--ethos-text-dim)');
  });

  it('stamps the accent as a CSS variable', () => {
    expect(runnerAccentVars(resolveRunner('pi'), false)).toEqual({
      '--runner-accent': '#2DD4BF',
    });
  });

  it('no runner hex appears anywhere in the web app source', () => {
    // The half of D19 that has to hold: a second harness must be one more map
    // entry, not a diff across the render tree.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes('__tests__')) continue;
      const text = readFileSync(file, 'utf8');
      for (const runner of Object.values(RUNNERS)) {
        if (!runner.accent) continue;
        if (text.includes(runner.accent.dark) || text.includes(runner.accent.light)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      yield full;
    }
  }
}
