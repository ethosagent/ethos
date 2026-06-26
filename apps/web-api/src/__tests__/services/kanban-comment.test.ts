import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanService } from '../../services/kanban.service';

describe('KanbanService — addComment + notify', () => {
  let dir: string;
  let meshDir: string;
  let mesh: AgentMesh;
  let service: KanbanService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-notify-'));
    meshDir = mkdtempSync(join(tmpdir(), 'mesh-notify-'));
    mesh = new AgentMesh(join(meshDir, 'registry.json'));
    service = new KanbanService({ teamsDir: dir, mesh });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(meshDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeManifest(name: string): void {
    writeFileSync(
      join(dir, `${name}.yaml`),
      `name: ${name}\ndescription: test\ndomain_capabilities: [x]\nmembers:\n  - personality: engineer\n`,
    );
  }

  function openBoard(name: string): KanbanStore {
    mkdirSync(join(dir, name), { recursive: true });
    return new KanbanStore(join(dir, name, 'board.db'));
  }

  it('addComment writes the comment and notifies the assigned agent with kind kanban_comment', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work', assignee: 'engineer' });
    store.updateStatus(task.id, 'ready');
    store.close();

    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
      displayName: 'Engineer',
      boardSubscriptions: ['team-a'],
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const { comment } = await service.addComment({
      team: 'team-a',
      taskId: task.id,
      body: 'please reconsider',
    });

    expect(comment.author).toBe('human:control-center');
    expect(comment.body).toBe('please reconsider');

    const verify = new KanbanStore(join(dir, 'team-a', 'board.db'));
    expect(verify.listComments(task.id).some((c) => c.body === 'please reconsider')).toBe(true);
    verify.close();

    await new Promise((r) => setTimeout(r, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/notify');
    expect(JSON.parse(opts.body as string)).toEqual({ kind: 'kanban_comment', ref: task.id });
  });

  it('addComment does not throw when /notify fails', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work', assignee: 'engineer' });
    store.updateStatus(task.id, 'ready');
    store.close();

    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
      displayName: 'Engineer',
      boardSubscriptions: ['team-a'],
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('refused'));

    const { comment } = await service.addComment({
      team: 'team-a',
      taskId: task.id,
      body: 'hello',
    });

    expect(comment.body).toBe('hello');
    // Drain the fire-and-forget notify (mesh file read + rejected fetch) before
    // the test ends, so it cannot leak into a later test's fetch spy.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('addComment does not notify when the task has no assignee', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'orphan' });
    store.updateStatus(task.id, 'ready');
    store.close();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await service.addComment({
      team: 'team-a',
      taskId: task.id,
      body: 'noone home',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
