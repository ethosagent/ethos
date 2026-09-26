import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { FsStorage } from '@ethosagent/storage-fs';
import { createTeamMemoryProvider } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanService } from '../../services/kanban.service';
import { TeamsService } from '../../services/teams.service';

// mobile-app plan S11 — `teams.list` carries each team's attention (blocked +
// needs_revision) so the phone's Teams screen is one call, not a list plus a
// `kanban.getBoard` per team. Computed by `KanbanService.attention`.

const manifest = (name: string) => `name: ${name}
description: ${name}
domain_capabilities: [x]
members:
  - personality: worker
`;

describe('teams.list attention (S11)', () => {
  let dir: string;
  let service: TeamsService;
  let clock: number;

  /** A store whose writes land at a controlled, strictly increasing time. */
  function board(team: string): KanbanStore {
    mkdirSync(join(dir, team), { recursive: true });
    return new KanbanStore(join(dir, team, 'board.db'), { teamId: team });
  }

  function tick(): void {
    clock += 1000;
    vi.setSystemTime(clock);
  }

  function block(store: KanbanStore, title: string): string {
    tick();
    const t = store.createTask({ title, assignee: 'worker' });
    store.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    store.blockRun(t.id, 'waiting', 'worker');
    return t.id;
  }

  function revise(store: KanbanStore, title: string): string {
    tick();
    const t = store.createTask({ title, assignee: 'worker' });
    store.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    store.updateStatus(t.id, 'needs_revision', 'missing sources', 'worker');
    return t.id;
  }

  async function team(name: string) {
    const { items } = await service.list();
    const found = items.find((t) => t.name === name);
    if (!found) throw new Error(`no team ${name}`);
    return found;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock = Date.parse('2026-09-27T10:00:00.000Z');
    vi.setSystemTime(clock);
    dir = mkdtempSync(join(tmpdir(), 'teams-attention-'));
    for (const name of ['three', 'four', 'empty']) {
      writeFileSync(join(dir, `${name}.yaml`), manifest(name));
    }
    const storage = new FsStorage();
    service = new TeamsService({
      kanban: new KanbanService({ teamsDir: dir }),
      storage,
      teamsDir: dir,
      teamMemory: (teamName) => createTeamMemoryProvider({ teamsDir: dir, teamName, storage }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('two blocked + one needs_revision → attentionCount 3, three tiles', async () => {
    const store = board('three');
    tick();
    const done = store.createTask({ title: 'not attention' });
    store.updateStatus(done.id, 'done', undefined, 'human:control-center');
    const a = block(store, 'blocked one');
    const b = block(store, 'blocked two');
    const c = revise(store, 'revise me');
    store.close();

    const t = await team('three');
    expect(t.attentionCount).toBe(3);
    expect(t.attention.map((x) => x.id)).toEqual([c, b, a]);
    expect(t.attention[0]).toEqual({
      id: c,
      title: 'revise me',
      status: 'needs_revision',
      assignee: 'worker',
      priority: expect.any(Number),
      updatedAt: expect.any(String),
    });
  });

  it('four attention tasks → count 4, the newest three, newest first', async () => {
    const store = board('four');
    const oldest = revise(store, 'oldest');
    const b = block(store, 'b');
    const c = revise(store, 'c');
    const d = block(store, 'd');
    store.close();

    const t = await team('four');
    expect(t.attentionCount).toBe(4);
    expect(t.attention.map((x) => x.id)).toEqual([d, c, b]);
    expect(t.attention.map((x) => x.id)).not.toContain(oldest);
  });

  it('a team with no board → 0 and []', async () => {
    const t = await team('empty');
    expect(t.attentionCount).toBe(0);
    expect(t.attention).toEqual([]);
  });
});
