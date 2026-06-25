import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchCall, Dispatcher, type SupervisorState } from '../dispatcher';

function makeSupervisor(
  members: Record<string, { port: number; status: 'running' | 'starting' | 'failed' }>,
): SupervisorState {
  return {
    portOf: (p) => members[p]?.port ?? null,
    statusOf: (p) => members[p]?.status ?? null,
  };
}

describe('Dispatcher — supervised dispatch regression (no mesh)', () => {
  let board: KanbanStore;

  beforeEach(() => {
    board = new KanbanStore(':memory:');
  });

  afterEach(() => {
    board.close();
  });

  it('[regression] supervised dispatch still works without mesh', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'fix bug', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    expect(board.getTask(t.id)?.status).toBe('running');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.port).toBe(3001);
  });

  it('[regression] supervisor skips failed agents without mesh, same as before mesh was added', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
    const t = board.createTask({ title: 'fix bug', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    expect(board.getTask(t.id)?.status).toBe('ready');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('[regression] supervisor resolves host as localhost for dispatch', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'review PR', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]?.[0];
    expect(call?.host).toBe('localhost');
    expect(call?.personalityId).toBe('engineer');
  });
});
