import type { CreateAgentLoopResult } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { type GoalsBackend, GoalsService } from '../goals.service';
import { InMemoryGoalStore, recordingExecutor } from './in-memory-goals';

// F05 (plan/phases/architecture-suggestions-2026-09-10.md) — GoalsService used
// to be a second composition root: it opened its own SQLiteGoalStore on
// `<dataDir>/goals.db` and, when the host did not forward the loop-bearing
// runner (the desktop never did), fell back to `new GoalRunner` with no
// `runAttempt`. `create` then wrote a `running` row and `startGoal` returned
// after `run_start` — a goal that showed as running forever with nothing
// executing it. These pin the replacement: the service drives exactly the
// store + executor pair it is handed, and refuses rather than fakes.

describe('GoalsService — injected goal backend', () => {
  it('works against an in-memory store + executor pair, with no SQLite and no dataDir', async () => {
    const store = new InMemoryGoalStore();
    const service = new GoalsService({
      goals: { store, executor: recordingExecutor({ canExecute: true }) },
    });

    const seeded = store.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'cli',
      title: 'seeded',
      goalText: 'already here',
    });
    store.appendEvent(seeded.id, 'run_start', { attemptN: 1 });

    expect((await service.list()).goals.map((g) => g.id)).toEqual([seeded.id]);
    const detail = await service.get(seeded.id);
    expect(detail.goal.title).toBe('seeded');
    expect(detail.events.map((e) => e.eventType)).toEqual(['run_start']);
    expect(await service.getGoal(seeded.id)).not.toBeNull();
    expect(await service.getEventsSince(seeded.id, 0)).toHaveLength(1);
  });

  it('create runs the executor on the SAME goal id it created', async () => {
    const store = new InMemoryGoalStore();
    const executor = recordingExecutor({ canExecute: true });
    const service = new GoalsService({ goals: { store, executor } });

    const { goal } = await service.create({ personalityId: 'p', goalText: 'Review this repo' });

    expect(executor.started).toEqual([goal.id]);
    // The row the executor was pointed at is the row this store holds — one
    // owner, not two stores that agree only on a filename.
    expect(store.get(goal.id)?.goalText).toBe('Review this repo');
    expect(store.get(goal.id)?.origin).toBe('web');
  });

  it('refuses create with NOT_CONFIGURED when the executor cannot execute, leaving no row', async () => {
    const store = new InMemoryGoalStore();
    const executor = recordingExecutor({ canExecute: false });
    const service = new GoalsService({ goals: { store, executor } });

    await expect(
      service.create({ personalityId: 'p', goalText: 'Review this repo' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });

    expect(store.list()).toEqual([]);
    expect(store.list({ status: 'running' })).toEqual([]);
    expect(executor.started).toEqual([]);
  });

  it('refuses create when no goal backend is wired at all, and reads degrade to empty', async () => {
    const service = new GoalsService({});

    await expect(
      service.create({ personalityId: 'p', goalText: 'Review this repo' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect((await service.list()).goals).toEqual([]);
    expect(await service.getGoal('anything')).toBeNull();
    expect(await service.getEventsSince('anything', 0)).toEqual([]);
    expect(await service.steer('anything', 'hi')).toEqual({ ok: false });
    expect(await service.cancel('anything')).toEqual({ ok: false });
  });

  it('refuses resume when execution is unavailable instead of flipping the goal to running', async () => {
    const store = new InMemoryGoalStore();
    const goal = store.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'web',
      title: 't',
      goalText: 'g',
    });
    store.updateStatus(goal.id, 'failed');
    let resumed = false;
    const executor = {
      ...recordingExecutor({ canExecute: false }),
      resume: async () => {
        resumed = true;
        return true;
      },
    };
    const service = new GoalsService({ goals: { store, executor } });

    await expect(service.resume(goal.id)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(resumed).toBe(false);
    expect(store.get(goal.id)?.status).toBe('failed');
  });

  it("accepts wiring's CreateAgentLoopResult.goals as its backend (compile-time)", () => {
    // Type-level: if wiring's pair stops satisfying the port GoalsService
    // drives, this stops compiling — the hosts forward `result.goals` as is.
    const fromWiring = (result: CreateAgentLoopResult): GoalsBackend => result.goals;
    expect(typeof fromWiring).toBe('function');
  });
});

// A chat turn for a team personality runs on that team's loop
// (`loopForPersonality`), but a GOAL for the same personality used to run on the
// main loop's pair: no `ctx.teamId`, the main kanban board, the main team
// memory. Goals resolve the same way now — one resolution, per personality.
describe('GoalsService — team personalities', () => {
  // Production shape: ONE goals.db (the pairs differ by RUNNER, not store — a
  // team loop opens its own connection to the same file), so the rows a team
  // goal writes are visible to the main pair's store too.
  const shared = () => {
    const store = new InMemoryGoalStore();
    return (canExecute = true) => ({ store, executor: recordingExecutor({ canExecute }) });
  };

  it('creates and runs a team personality goal on that team’s pair', async () => {
    const pair = shared();
    const main = pair();
    const team = pair();
    const service = new GoalsService({
      goals: main,
      goalsFor: async (personalityId) => (personalityId === 'marketer' ? team : undefined),
    });

    const { goal } = await service.create({ personalityId: 'marketer', goalText: 'draft a post' });

    expect(team.executor.started).toEqual([goal.id]);
    expect(team.store.get(goal.id)?.personalityId).toBe('marketer');
    expect(main.executor.started).toEqual([]);
  });

  it('leaves a personality with no team on the main pair', async () => {
    const pair = shared();
    const main = pair();
    const team = pair();
    const service = new GoalsService({
      goals: main,
      goalsFor: async (personalityId) => (personalityId === 'marketer' ? team : undefined),
    });

    const { goal } = await service.create({ personalityId: 'operator', goalText: 'do it' });

    expect(main.executor.started).toEqual([goal.id]);
    expect(team.executor.started).toEqual([]);
  });

  it('steers, cancels and resumes a team goal on the team pair that runs it', async () => {
    const pair = shared();
    const main = pair();
    const team = pair();
    const service = new GoalsService({
      goals: main,
      goalsFor: async (personalityId) => (personalityId === 'marketer' ? team : undefined),
    });
    const { goal } = await service.create({ personalityId: 'marketer', goalText: 'draft a post' });
    let steered = 0;
    let cancelled = 0;
    let resumed = 0;
    team.executor.steer = () => {
      steered++;
      return true;
    };
    team.executor.cancel = () => {
      cancelled++;
      return true;
    };
    team.executor.resume = async () => {
      resumed++;
      return true;
    };

    expect(await service.steer(goal.id, 'faster')).toEqual({ ok: true });
    expect(await service.cancel(goal.id)).toEqual({ ok: true });
    expect(await service.resume(goal.id)).toEqual({ ok: true });
    expect([steered, cancelled, resumed]).toEqual([1, 1, 1]);
  });

  it('refuses a team goal when that team’s executor cannot run it, leaving no row', async () => {
    const pair = shared();
    const main = pair();
    const team = pair(false);
    const service = new GoalsService({
      goals: main,
      goalsFor: async (personalityId) => (personalityId === 'marketer' ? team : undefined),
    });

    await expect(
      service.create({ personalityId: 'marketer', goalText: 'draft a post' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(team.store.list()).toEqual([]);
  });
});
