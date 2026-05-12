import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService } from '../../services/kanban.service';

// Drive the service against a real on-disk teams directory so we exercise the
// manifest read, runtime probe, and SQLite open paths the way the live server
// would. No HTTP — that's covered by the routes test layer.

describe('KanbanService', () => {
  let dir: string;
  let service: KanbanService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-svc-'));
    service = new KanbanService({ teamsDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(name: string, content: string): void {
    writeFileSync(join(dir, `${name}.yaml`), content);
  }

  function openBoard(name: string): KanbanStore {
    mkdirSync(join(dir, name), { recursive: true });
    return new KanbanStore(join(dir, name, 'board.db'));
  }

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  it('list returns an empty array when no teams exist', async () => {
    const { teams } = await service.list();
    expect(teams).toEqual([]);
  });

  it('list returns parsed teams from manifests on disk', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: Quarterly analytics roadmap
domain_capabilities: [analytics]
coordinator: coordinator
members:
  - personality: coordinator
    role: coordinator
  - personality: data-engineer
    role: member
`,
    );

    const { teams } = await service.list();
    expect(teams).toHaveLength(1);
    expect(teams[0]?.name).toBe('analytics');
    expect(teams[0]?.dispatchMode).toBe('coordinator');
    expect(teams[0]?.memberCount).toBe(2);
    expect(teams[0]?.health).toBe('stopped'); // no runtime file
    expect(teams[0]?.boardModifiedAt).toBeNull();
  });

  it('list skips malformed manifests instead of throwing', async () => {
    writeManifest(
      'good',
      `
name: good
description: ok
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    writeManifest('bad', 'this: is: not: valid: yaml:::');

    const { teams } = await service.list();
    expect(teams.map((t) => t.name)).toEqual(['good']);
  });

  it('list reports boardModifiedAt when a board.db exists', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    store.createTask({ title: 'first' });
    store.close();

    const { teams } = await service.list();
    expect(teams[0]?.boardModifiedAt).not.toBeNull();
    // ISO-8601 sanity check.
    expect(() => new Date(teams[0]?.boardModifiedAt ?? '')).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // getBoard
  // ---------------------------------------------------------------------------

  it('getBoard returns the team summary + tasks + links + recent events', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
coordinator: coordinator
members:
  - personality: coordinator
    role: coordinator
  - personality: engineer
    role: member
`,
    );
    const store = openBoard('analytics');
    const goal = store.createTask({ title: 'Q3 roadmap', actor: 'coordinator' });
    const child = store.createTask({
      title: 'do the thing',
      assignee: 'engineer',
      parents: [goal.id],
      actor: 'coordinator',
    });
    store.updateStatus(child.id, 'running', undefined, 'engineer');
    store.close();

    const { board } = await service.getBoard('analytics');
    expect(board.team.name).toBe('analytics');
    expect(board.tasks.map((t) => t.id).sort()).toEqual([goal.id, child.id].sort());
    // The link writeback came through createTask({parents}).
    expect(board.links).toEqual([{ parentId: goal.id, childId: child.id }]);
    // Audit trail surfaces.
    const kinds = board.recentEvents.map((e) => e.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('linked');
    expect(kinds).toContain('status_changed');
    expect(kinds).toContain('run_started');
  });

  it('getBoard returns an empty snapshot when no board.db exists yet', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const { board } = await service.getBoard('analytics');
    expect(board.tasks).toEqual([]);
    expect(board.links).toEqual([]);
    expect(board.recentEvents).toEqual([]);
  });

  it('getBoard rejects unknown teams', async () => {
    await expect(service.getBoard('does-not-exist')).rejects.toThrow(/team not found/);
  });

  // ---------------------------------------------------------------------------
  // updateStatus — path-traversal guard
  // ---------------------------------------------------------------------------

  it('rejects path-traversal team names on getBoard and updateStatus', async () => {
    await expect(service.getBoard('..')).rejects.toThrow(/invalid team name/);
    await expect(service.getBoard('foo/bar')).rejects.toThrow(/invalid team name/);
    await expect(
      service.updateStatus({ team: '..', taskId: 't_x', status: 'done', actor: 'human:test' }),
    ).rejects.toThrow(/invalid team name/);
  });

  it('updateStatus writes through the store and tags the actor', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const t = store.createTask({ title: 'work' });
    store.close();

    const { task } = await service.updateStatus({
      team: 'analytics',
      taskId: t.id,
      status: 'done',
      reason: 'closed via UI',
      actor: 'human:control-center',
    });
    expect(task.status).toBe('done');

    // Re-open and confirm the audit event records the human actor.
    const reread = new KanbanStore(join(dir, 'analytics', 'board.db'));
    const events = reread.listEvents(t.id);
    const statusChange = events.find((e) => e.kind === 'status_changed');
    expect(statusChange?.actor).toBe('human:control-center');
    reread.close();
  });
});
