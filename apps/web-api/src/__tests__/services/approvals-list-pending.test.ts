import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { ApprovalsService } from '../../services/approvals.service';

// `tools.listPending` (S3) — the foreground catch-up D13 requires: a client
// that missed the `pending` SSE event (a closed tab, a cold app launch) reads
// the current queue instead. Lifecycle: request → listed; approve → gone;
// forget (`cancelForSession`) → gone; timeout auto-deny → gone, and the
// `resolved` event names the timeout decider.

const DATA = '/data';
const SYSTEM_DECIDER = '__ethos_system__';

function nextPending(service: ApprovalsService): Promise<ApprovalRequest> {
  return new Promise<ApprovalRequest>((resolve) => {
    const off = service.onPending((_, req) => {
      off();
      resolve(req);
    });
  });
}

describe('ApprovalsService.listPending', () => {
  let allowlist: AllowlistRepository;
  let approvals: ApprovalsService;

  beforeEach(() => {
    const storage = new InMemoryStorage();
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    approvals = new ApprovalsService({ allowlist });
  });

  it('a requested approval is listed, optionally scoped by sessionId', async () => {
    const pending = nextPending(approvals);
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'ls' },
    });
    const req = await pending;

    expect(approvals.listPending()).toEqual([req]);
    expect(approvals.listPending('sess_1')).toEqual([req]);
    expect(approvals.listPending('sess_other')).toEqual([]);
  });

  it('approve removes it from the pending list', async () => {
    const pending = nextPending(approvals);
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const req = await pending;

    await approvals.approve(req.approvalId, 'once', 'human:tab-a');

    expect(approvals.listPending()).toEqual([]);
  });

  it('forgetting the session removes it from the pending list', async () => {
    const pending = nextPending(approvals);
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    await pending;

    approvals.cancelForSession('sess_1');

    expect(approvals.listPending()).toEqual([]);
  });

  it('a timed-out approval is gone, and the resolved event names the timeout decider', async () => {
    vi.useFakeTimers();
    try {
      const timed = new ApprovalsService({ allowlist, timeoutMs: 10 });
      const pending = nextPending(timed);
      const resolvedDecidedBy = new Promise<string>((resolve) => {
        const off = timed.onResolved((_sessionId, _approvalId, _decision, decidedBy) => {
          off();
          resolve(decidedBy);
        });
      });
      void timed.requestApproval({
        sessionId: 'sess_1',
        toolCallId: 'tc_1',
        toolName: 'terminal',
        args: {},
      });
      const req = await pending;

      await vi.advanceTimersByTimeAsync(10);

      expect(await resolvedDecidedBy).toBe(SYSTEM_DECIDER);
      expect(timed.listPending()).toEqual([]);
      expect(timed.listPending(req.sessionId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
