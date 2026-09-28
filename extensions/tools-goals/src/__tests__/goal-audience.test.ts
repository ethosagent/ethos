// plan personality-memory-boundary G1-6 — a goal has no audience column; its
// runs derive the room audience from `Goal.origin` (`goalRoomAudience`). A
// shared turn must therefore not create a goal whose origin derives private:
// `goal_create` refuses it (fail closed), and a shared turn in a room keeps
// working because its origin derives shared.

import type { GoalStore, Tool, ToolContext, TurnAudience } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
// Relative on purpose: the derivation lives in the composition root, which
// binds it into `createGoalTools`; the test binds the real one the same way.
import { goalRoomAudience } from '../../../../packages/wiring/src/goal-audience';
import { createGoalTools, type GoalOriginAudience } from '../index';

function goalCreate(originAudience?: GoalOriginAudience) {
  const create = vi.fn((input: Record<string, unknown>) => ({ id: 'g1', ...input }));
  const store = { create } as unknown as GoalStore;
  const tool = createGoalTools(store, undefined, originAudience).find(
    (t) => t.name === 'goal_create',
  ) as Tool<unknown>;
  return { tool, create };
}

const real: GoalOriginAudience = (origin) => goalRoomAudience(origin);
const args = { title: 't', goal_text: 'do it' };

function ctx(roomAudience?: TurnAudience, origin?: string): ToolContext {
  return {
    personalityId: 'eng',
    sessionKey: 'telegram:bot1:-100200:sub:abc',
    ...(roomAudience ? { roomAudience } : {}),
    ...(origin ? { origin } : {}),
  } as unknown as ToolContext;
}

describe('goal_create — room audience (G1-6)', () => {
  it('refuses a shared delegated child with no origin (it would record `web` and run private)', async () => {
    const { tool, create } = goalCreate(real);
    const res = await tool.execute(args, ctx('shared'));
    expect(res).toMatchObject({ ok: false, code: 'not_available' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a shared turn whose origin is provably one-to-one', async () => {
    const { tool, create } = goalCreate(real);
    expect((await tool.execute(args, ctx('shared', 'telegram:4242'))).ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a shared turn in a group: the goal records the room and derives shared', async () => {
    const { tool, create } = goalCreate(real);
    const res = await tool.execute(args, ctx('shared', 'telegram:-100200'));
    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ origin: 'telegram:-100200' }));
    expect(goalRoomAudience('telegram:-100200')).toBe('shared');
  });

  it('fails closed when no derivation is wired: every shared-turn goal is refused', async () => {
    const { tool, create } = goalCreate();
    expect((await tool.execute(args, ctx('shared', 'telegram:-100200'))).ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('private and unstamped turns are unchanged', async () => {
    const { tool, create } = goalCreate(real);
    expect((await tool.execute(args, ctx('private'))).ok).toBe(true);
    expect((await tool.execute(args, ctx())).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ origin: 'web' }));
  });
});
