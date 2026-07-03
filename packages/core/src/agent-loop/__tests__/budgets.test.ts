import { describe, expect, it } from 'vitest';
import { checkTurnBudgets, type IdenticalStreak, updateIdenticalStreak } from '../budgets';

function foldCalls(calls: Array<{ toolName: string; args: unknown }>): IdenticalStreak | null {
  let streak: IdenticalStreak | null = null;
  for (const call of calls) {
    streak = updateIdenticalStreak(streak, call.toolName, call.args);
  }
  return streak;
}

function check(streak: IdenticalStreak | null, maxConsecutive: number) {
  return checkTurnBudgets(0, 100, new Map(), 100, streak, maxConsecutive);
}

describe('updateIdenticalStreak', () => {
  it('increments the streak on consecutive identical tool+args calls', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(streak).toEqual({
      key: `read_file:${JSON.stringify({ path: '/a' })}`,
      toolName: 'read_file',
      count: 3,
    });
  });

  it('resets to 1 when the same tool is called with different args', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/b' } },
    ]);
    expect(streak?.count).toBe(1);
  });

  it('resets to 1 when a different tool interleaves', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'bash', args: { command: 'ls' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(streak).toEqual({
      key: `read_file:${JSON.stringify({ path: '/a' })}`,
      toolName: 'read_file',
      count: 1,
    });
  });

  it('falls back to the tool name when args are not serializable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const first = updateIdenticalStreak(null, 'weird_tool', circular);
    const second = updateIdenticalStreak(first, 'weird_tool', circular);
    expect(second).toEqual({ key: 'weird_tool', toolName: 'weird_tool', count: 2 });
  });
});

describe('checkTurnBudgets — consecutive-identical-call guard', () => {
  it('does not trip below the threshold', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(check(streak, 5)).toEqual({ exceeded: false });
  });

  it('trips at the threshold with a loop message', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(check(streak, 5)).toEqual({
      exceeded: true,
      rule: 'identical-streak',
      toolName: 'read_file',
      count: 5,
      message: 'Stopped: read_file called 5 times in a row with identical arguments (loop)',
    });
  });

  it('does not trip when the same tool is called many times with different args', () => {
    const streak = foldCalls(
      Array.from({ length: 10 }, (_, i) => ({ toolName: 'read_file', args: { path: `/f${i}` } })),
    );
    expect(check(streak, 5)).toEqual({ exceeded: false });
  });

  it('does not trip when an interleaved different tool keeps resetting the streak', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'bash', args: { command: 'ls' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(check(streak, 5)).toEqual({ exceeded: false });
  });

  it('handles a null streak (no tool calls yet)', () => {
    expect(check(null, 5)).toEqual({ exceeded: false });
  });

  it('keeps the existing total and per-name caps intact', () => {
    expect(checkTurnBudgets(100, 100, new Map(), 25, null, 5)).toEqual({
      exceeded: true,
      rule: 'tool-budget',
      toolName: '_budget',
      count: 100,
      message: 'Stopped: hit 100-tool-call budget for this turn',
    });
    expect(checkTurnBudgets(30, 100, new Map([['bash', 25]]), 25, null, 5)).toEqual({
      exceeded: true,
      rule: 'identical-name',
      toolName: 'bash',
      count: 25,
      message: 'Stopped: bash called 25 times in one turn (likely loop)',
    });
  });
});
