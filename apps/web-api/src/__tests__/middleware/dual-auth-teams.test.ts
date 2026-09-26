import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import type { ServiceContainer } from '../../routes/index';
import { rpcRoutes } from '../../routes/rpc';
import { KanbanService } from '../../services/kanban.service';

// mobile-app plan S1 (T5) — `kanban`, `teams` and `cron` in `SCOPE_MAP`,
// over the real `/rpc` stack: the scope gate in `dualAuth` and, for a
// bearer kanban write, the actor `rpc/kanban.ts`'s `actorFor` stamps (S9).

describe('dualAuth — kanban / teams / cron scopes over /rpc', () => {
  let dir: string;
  let keys: SqliteApiKeyStore;
  let app: Hono;
  let kanban: KanbanService;
  let taskId: string;

  async function key(name: string, scopes: string[]): Promise<string> {
    return (await keys.create({ name, scopes })).secret;
  }

  function rpc(path: string, secret: string, input: object) {
    return app.request(`/rpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ json: input }),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-teams-scopes-'));
    const teamsDir = join(dir, 'teams');
    mkdirSync(join(teamsDir, 'marketing'), { recursive: true });
    writeFileSync(
      join(teamsDir, 'marketing.yaml'),
      'name: marketing\ndescription: m\ndomain_capabilities: [x]\nmembers:\n  - personality: scout\n',
    );
    const store = new KanbanStore(join(teamsDir, 'marketing', 'board.db'), {
      teamId: 'marketing',
    });
    const t = store.createTask({ title: 'weekly digest', assignee: 'scout' });
    store.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    store.updateStatus(t.id, 'needs_revision', 'no source links', 'scout');
    store.close();
    taskId = t.id;

    kanban = new KanbanService({ teamsDir });
    keys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    app = new Hono();
    app.onError(errorHandler);
    app.use('/rpc/*', dualAuth({ tokens, apiKeys: keys, scopeForPath: resolveScope }));
    app.route('/rpc', rpcRoutes({ services: { kanban } as unknown as ServiceContainer }));
  });

  afterEach(() => {
    keys.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a key with kanban:read can call kanban.getBoard', async () => {
    const res = await rpc('kanban/getBoard', await key('reader', ['kanban:read']), {
      team: 'marketing',
    });
    expect(res.status).toBe(200);
    const { json } = (await res.json()) as { json: { board: { tasks: Array<{ id: string }> } } };
    expect(json.board.tasks.map((t) => t.id)).toEqual([taskId]);
  });

  it('kanban.updateStatus requires kanban:write', async () => {
    const res = await rpc('kanban/updateStatus', await key('reader', ['kanban:read']), {
      team: 'marketing',
      taskId,
      status: 'done',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/scope "kanban:write"/);
  });

  it('approving needs_revision → done by bearer records human:key:<name> in the audit trail', async () => {
    const reason = 'approved by operator, verifier bypassed';
    const res = await rpc('kanban/updateStatus', await key('iphone', ['kanban:write']), {
      team: 'marketing',
      taskId,
      status: 'done',
      reason,
    });
    expect(res.status).toBe(200);

    const events = await kanban.getRecentEvents('marketing');
    const last = events[events.length - 1];
    expect(last?.kind).toBe('status_changed');
    expect(last?.actor).toBe('human:key:iphone');
    expect(last?.data).toMatchObject({ from: 'needs_revision', to: 'done', reason });
  });

  it('teams.memoryWrite is refused for bearer, even with teams:read', async () => {
    const res = await rpc('teams/memoryWrite', await key('t', ['teams:read']), {
      team: 'marketing',
      key: 'decisions',
      action: 'add',
      content: 'x',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/requires cookie/);
  });

  it('cron.runNow is refused for bearer, even with cron:read', async () => {
    const res = await rpc('cron/runNow', await key('c', ['cron:read']), { id: 'job-1' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/requires cookie/);
  });
});
