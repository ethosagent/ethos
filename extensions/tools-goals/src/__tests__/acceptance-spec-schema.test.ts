// S1 (plan openclaw-2026.9.6-gaps) — `goal_create` validates each
// `acceptance_spec.checks[]` item instead of casting the model's object to
// `AcceptanceSpec`. An unknown shape is refused with `input_invalid` and no
// goal is stored.

import type { GoalStore, Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createGoalTools } from '../index';

function goalCreate() {
  const create = vi.fn((input: Record<string, unknown>) => ({ id: 'g1', ...input }));
  const store = { create } as unknown as GoalStore;
  const tool = createGoalTools(store).find((t) => t.name === 'goal_create') as Tool<unknown>;
  return { tool, create };
}

const ctx = { personalityId: 'eng' } as unknown as ToolContext;
const base = { title: 't', goal_text: 'do it' };

describe('goal_create — acceptance_spec.checks[] item schema', () => {
  it.each([
    ['a string item', ['echo hi']],
    ['a null item', [null]],
    ['an item without id', [{ description: 'd' }]],
    ['a non-string command', [{ id: 'c', description: 'd', command: 42 }]],
    ['an unknown key', [{ id: 'c', description: 'd', run: 'echo hi' }]],
  ])('refuses %s with input_invalid', async (_label, checks) => {
    const { tool, create } = goalCreate();
    const result = await tool.execute(
      { ...base, acceptance_spec: { checks, rubric: [], threshold: 0.8 } },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a checks value that is not an array', async () => {
    const { tool, create } = goalCreate();
    const result = await tool.execute(
      { ...base, acceptance_spec: { checks: 'npm test', rubric: [], threshold: 0.8 } },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts well-formed items with and without a command', async () => {
    const { tool, create } = goalCreate();
    const checks = [
      { id: 'c1', description: 'tests pass', command: 'pnpm test' },
      { id: 'c2', description: 'mentions the fix' },
    ];
    const result = await tool.execute(
      { ...base, acceptance_spec: { checks, rubric: [], threshold: 0.8 } },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ acceptanceCriteria: { checks, rubric: [], threshold: 0.8 } }),
    );
  });
});
