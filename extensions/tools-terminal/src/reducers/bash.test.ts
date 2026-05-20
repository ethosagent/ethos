import type { ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { bashReducer } from './bash';

const ctx = { args: {}, turnCount: 0 };

function makeCtxWithCmd(command: string) {
  return { args: { command }, turnCount: 0 };
}

describe('bashReducer', () => {
  it('git status output with 3 modified files → summary line with counts', () => {
    const output = [
      ' M packages/core/src/foo.ts',
      ' M packages/types/src/bar.ts',
      'M  extensions/tools-terminal/src/index.ts',
      '?? new-file.ts',
    ].join('\n');
    const result: ToolResult = { ok: true, value: output };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('git status'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('git status:');
      expect(reduced.value).toContain('modified');
      expect(reduced.value).toContain('untracked');
    }
  });

  it('vitest output with Test Files/Tests/Duration lines → keeps summary block', () => {
    const output = [
      'some long noise line 1',
      'some long noise line 2',
      'some long noise line 3',
      ' Test Files  5 passed (5)',
      ' Tests  42 passed (42)',
      ' Duration  1.23s',
    ].join('\n');
    const result: ToolResult = { ok: true, value: output };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('pnpm test'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('Test Files');
      expect(reduced.value).toContain('Tests');
      expect(reduced.value).toContain('Duration');
      // Noise lines should not be present
      expect(reduced.value).not.toContain('some long noise line 1');
    }
  });

  it('pnpm install output with "added 10 packages" line → keeps summary line', () => {
    const output = [
      'Resolving dependencies...',
      'Fetching packages...',
      'added 10 packages in 2.1s',
      'Done.',
    ].join('\n');
    const result: ToolResult = { ok: true, value: output };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('pnpm install'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('added 10 packages');
    }
  });

  it('large output (>8KB) → reduces to head+tail with marker', () => {
    // Each line is ~60 chars; 500 lines = ~30KB
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}-${'x'.repeat(50)}`);
    const bigOutput = lines.join('\n');
    expect(bigOutput.length).toBeGreaterThan(8 * 1024);

    const result: ToolResult = { ok: true, value: bigOutput };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('some-long-command'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('[reduced from');
      expect(reduced.value).toContain('head+tail');
      expect(reduced.value).toContain('line-0-');
      expect(reduced.value).toContain('line-499-');
    }
  });

  it('error result → passes through unchanged', () => {
    const result: ToolResult = { ok: false, error: 'command failed', code: 'execution_failed' };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('git status'));
    expect(reduced).toEqual(result);
  });

  it('small output (≤8KB) with no special command → passes through unchanged', () => {
    const result: ToolResult = { ok: true, value: 'hello world' };
    const reduced = bashReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
});
