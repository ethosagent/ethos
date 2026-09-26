import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { kanbanRouter } from '../../rpc/kanban';
import { toolsRouter } from '../../rpc/tools';
import { ApprovalsService } from '../../services/approvals.service';
import { KanbanService } from '../../services/kanban.service';

// S9 — the actor is stamped server-side from the API-key row, never from a
// client-supplied string. Bearer -> `human:key:<name>` on both kanban writes
// (`rpc/kanban.ts`) and `tools.approve`/`deny`'s `decidedBy` (`rpc/tools.ts`);
// cookie keeps today's values; a spoofed `clientId` under bearer is ignored.
//
// Router entries are invoked directly via oRPC's `.callable()` rather than
// over HTTP, to pin the actor derivation at the layer it lives in. The same
// path over real bearer HTTP (`kanban:write`, mapped in T5) is pinned by
// `middleware/dual-auth-teams.test.ts`.

/** Invoke a router entry's handler directly, bypassing HTTP/dualAuth — see
 *  the file header. oRPC's `DecoratedProcedure` type isn't exported for a
 *  narrower cast, so the `any` is confined to this one helper. */
// biome-ignore lint/suspicious/noExplicitAny: oRPC's procedure type isn't exported; see the doc comment above.
function callDirect(procedure: any, context: object, input: object): Promise<any> {
  return procedure.callable({ context: () => context })(input);
}

const DATA = '/data';

describe('actor stamping (S9) — kanban writes', () => {
  let dir: string;
  let kanban: KanbanService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'actor-stamp-kanban-'));
    kanban = new KanbanService({ teamsDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function lastEventActor(): Promise<string | undefined> {
    const events = await kanban.getRecentEvents('analytics');
    return events[events.length - 1]?.actor;
  }

  it('bearer stamps human:key:<name>', async () => {
    const { task } = await kanban.createTask({
      team: 'analytics',
      title: 'ship it',
      actor: 'system',
    });
    const context = { kanban, _authMethod: 'bearer', _apiKey: { name: 'iphone' } };
    await callDirect(kanbanRouter.updateStatus, context, {
      team: 'analytics',
      taskId: task.id,
      status: 'running',
    });

    expect(await lastEventActor()).toBe('human:key:iphone');
  });

  it('cookie keeps human:control-center', async () => {
    const { task } = await kanban.createTask({
      team: 'analytics',
      title: 'ship it',
      actor: 'system',
    });
    const context = { kanban, _authMethod: 'cookie' };
    await callDirect(kanbanRouter.updateStatus, context, {
      team: 'analytics',
      taskId: task.id,
      status: 'running',
    });

    expect(await lastEventActor()).toBe('human:control-center');
  });

  it('no _authMethod at all (cookie-only deployment) also keeps human:control-center', async () => {
    const { task } = await kanban.createTask({
      team: 'analytics',
      title: 'ship it',
      actor: 'system',
    });
    const context = { kanban };
    await callDirect(kanbanRouter.updateStatus, context, {
      team: 'analytics',
      taskId: task.id,
      status: 'running',
    });

    expect(await lastEventActor()).toBe('human:control-center');
  });
});

describe('actor stamping (S9) — tools.approve / tools.deny decidedBy', () => {
  let allowlist: AllowlistRepository;
  let approvals: ApprovalsService;

  beforeEach(() => {
    const storage = new InMemoryStorage();
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    approvals = new ApprovalsService({ allowlist });
  });

  function nextPending(): Promise<ApprovalRequest> {
    return new Promise<ApprovalRequest>((resolve) => {
      const off = approvals.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
  }

  function nextResolvedDecidedBy(): Promise<string> {
    return new Promise<string>((resolve) => {
      const off = approvals.onResolved((_sessionId, _approvalId, _decision, decidedBy) => {
        off();
        resolve(decidedBy);
      });
    });
  }

  it('bearer stamps human:key:<name> on approve, ignoring a spoofed clientId', async () => {
    const pending = nextPending();
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const req = await pending;
    const resolved = nextResolvedDecidedBy();

    const context = { approvals, _authMethod: 'bearer', _apiKey: { name: 'iphone' } };
    await callDirect(toolsRouter.approve, context, {
      approvalId: req.approvalId,
      scope: 'once',
      clientId: 'attacker-claims-to-be-someone-else',
    });

    expect(await resolved).toBe('human:key:iphone');
  });

  it('bearer stamps human:key:<name> on deny too', async () => {
    const pending = nextPending();
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const req = await pending;
    const resolved = nextResolvedDecidedBy();

    const context = { approvals, _authMethod: 'bearer', _apiKey: { name: 'iphone' } };
    await callDirect(toolsRouter.deny, context, {
      approvalId: req.approvalId,
      clientId: 'attacker-claims-to-be-someone-else',
    });

    expect(await resolved).toBe('human:key:iphone');
  });

  it('cookie keeps the client-supplied clientId', async () => {
    const pending = nextPending();
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const req = await pending;
    const resolved = nextResolvedDecidedBy();

    const context = { approvals, _authMethod: 'cookie' };
    await callDirect(toolsRouter.deny, context, {
      approvalId: req.approvalId,
      clientId: 'tab-a',
    });

    expect(await resolved).toBe('tab-a');
  });
});
