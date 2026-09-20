import type { PushDeviceRecord } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { BackgroundJob } from '@ethosagent/types';
import type { KanbanEvent } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { ApprovalsService } from '../../services/approvals.service';
import { PushDispatcher } from '../../services/push-dispatcher';
import type { PushMessage, PushSendResult, PushTransport } from '../../services/push-transport';
import { SystemEventBus } from '../../services/system-event-bus';

// S5 — the dispatcher's table: each source event → the minimal payload a phone
// receives (D11). Driven against a recording transport; the last case wires the
// REAL ApprovalsService + SystemEventBus through `start()` so the subscriptions,
// the deadline and the timeout replacement are pinned end to end.

function fakeTransport(result: PushSendResult = { ok: true, sent: 1 }) {
  const sent: PushMessage[][] = [];
  const transport: PushTransport = {
    send: async (messages) => {
      sent.push(messages);
      return result;
    },
    close: () => {},
  };
  return { transport, sent };
}

const ALL_ON = {
  approvals: true,
  clarify: true,
  cronFailures: true,
  teamAttention: true,
  runFinished: true,
};

function device(overrides: Partial<PushDeviceRecord> = {}): PushDeviceRecord {
  return {
    apiKeyId: 'key-1',
    expoPushToken: 'ExponentPushToken[aaa]',
    platform: 'ios',
    categories: { ...ALL_ON },
    liveActivities: false,
    appVersion: '0.1.0',
    lastRegisteredAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function build(devices: PushDeviceRecord[], result?: PushSendResult) {
  const { transport, sent } = fakeTransport(result);
  const dispatcher = new PushDispatcher({
    devices: {
      listForActiveKeys: (apiKeyId?: string) =>
        devices.filter((d) => apiKeyId === undefined || d.apiKeyId === apiKeyId),
    },
    transport,
    personalityFor: async () => 'engineer',
  });
  return { dispatcher, sent };
}

describe('PushDispatcher', () => {
  it('approvalPending sends a time-sensitive approval push', async () => {
    const { dispatcher, sent } = build([device()]);
    const request = {
      approvalId: 'appr-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: { command: 'rm -rf /secret-arg' },
      reason: null,
    };
    await dispatcher.approvalPending('sess-1', request, '2026-09-19T10:00:00.000Z');
    const msg = sent[0]?.[0];
    expect(msg?.to).toBe('ExponentPushToken[aaa]');
    expect(msg?.categoryId).toBe('approval');
    expect(msg?.collapseId).toBe('appr-1');
    expect(msg?.threadId).toBe('sess-1');
    expect(msg?.interruptionLevel).toBe('time-sensitive');
    expect(msg?.mutableContent).toBe(true);
    expect(msg?.data).toEqual({
      category: 'approvals',
      approvalId: 'appr-1',
      personality: 'engineer',
      deadline: '2026-09-19T10:00:00.000Z',
      deepLink: 'ethos://p/engineer/chat',
    });
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('secret-arg');
    expect(serialized).not.toContain('"args"');
  });

  it('auto-deny sends a replacement with the same collapseId', async () => {
    const { dispatcher, sent } = build([device()]);
    const request = {
      approvalId: 'appr-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: {},
      reason: null,
    };
    await dispatcher.approvalPending('sess-1', request, null);
    await dispatcher.approvalResolved('sess-1', 'appr-1', '__ethos_system__');
    expect(sent.length).toBe(2);
    const first = sent[0]?.[0];
    const second = sent[1]?.[0];
    expect(second?.collapseId).toBe('appr-1');
    expect(second?.threadId).toBe('sess-1');
    expect(second?.categoryId).toBeUndefined();
    expect(second?.title).toBe(first?.title);
    expect(second?.body).toMatch(/^auto-denied at \d\d:\d\d$/);
  });

  it('a human decision does not push', async () => {
    const { dispatcher, sent } = build([device()]);
    const request = {
      approvalId: 'appr-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: {},
      reason: null,
    };
    await dispatcher.approvalPending('sess-1', request, null);
    await dispatcher.approvalResolved('sess-1', 'appr-1', 'human:key:iphone');
    expect(sent.length).toBe(1);
  });

  it('an approval nobody was notified of gets no replacement', async () => {
    const { dispatcher, sent } = build([device()]);
    await dispatcher.approvalResolved('sess-1', 'never-seen', '__ethos_system__');
    expect(sent.length).toBe(0);
  });

  // D11 deviation: a clarify push never carries a categoryId, regardless of
  // option count — see the `clarify()` comment in push-dispatcher.ts.
  it.each([
    { options: ['a', 'b', 'c'] },
    { options: ['a', 'b', 'c', 'd'] },
    { options: undefined },
    { options: ['yes'] },
  ])('clarify carries no categoryId for $options', async ({ options }) => {
    const { dispatcher, sent } = build([device()]);
    await dispatcher.clarify('sess-1', {
      requestId: 'cl-1',
      question: 'Which branch?',
      options,
      defaultDeadlineAt: null,
    });
    const msg = sent[0]?.[0];
    expect(msg?.categoryId).toBeUndefined();
    expect(msg?.data.category).toBe('clarify');
    expect(msg?.data.clarifyId).toBe('cl-1');
    expect(msg?.body).toBe('Which branch?');
    expect(msg?.interruptionLevel).toBe('active');
  });

  it('cronFailed pushes the error in the body', async () => {
    const { dispatcher, sent } = build([device()]);
    await dispatcher.cronFailed({
      type: 'cron.failed',
      jobId: 'j1',
      jobName: 'nightly',
      error: 'exit 2: disk full',
    });
    const msg = sent[0]?.[0];
    expect(msg?.body).toContain('exit 2: disk full');
    expect(msg?.data.category).toBe('cronFailures');
    expect(msg?.interruptionLevel).toBe('active');
  });

  it.each([
    {
      label: 'needs_revision with reason',
      events: [
        {
          id: 1,
          taskId: 'MKT-1',
          kind: 'status_changed',
          actor: 'agent',
          data: {
            from: 'running',
            to: 'needs_revision',
            reason: 'acceptance criteria unmet',
          },
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      ] as KanbanEvent[],
      check: (msg: PushMessage) => {
        expect(msg.body).toContain('needs revision');
        expect(msg.body).toContain('acceptance criteria unmet');
        expect(msg.data.deepLink).toBe('ethos://t/marketing/task/MKT-1');
        expect(msg.data.category).toBe('teamAttention');
      },
    },
    {
      label: 'blocked with run_completed summary',
      events: [
        {
          id: 1,
          taskId: 'MKT-2',
          kind: 'run_completed',
          actor: 'agent',
          data: { outcome: 'blocked', summary: 'waiting on API key' },
          createdAt: '2026-09-19T00:00:00.000Z',
        },
        {
          id: 2,
          taskId: 'MKT-2',
          kind: 'status_changed',
          actor: 'agent',
          data: { from: 'running', to: 'blocked' },
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      ] as KanbanEvent[],
      check: (msg: PushMessage) => {
        expect(msg.body).toContain('blocked');
        expect(msg.body).toContain('waiting on API key');
      },
    },
    {
      label: 'done status is silent',
      events: [
        {
          id: 1,
          taskId: 'MKT-3',
          kind: 'status_changed',
          actor: 'agent',
          data: { from: 'running', to: 'done' },
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      ] as KanbanEvent[],
      check: null,
    },
  ])('kanbanEvents: $label', async ({ events, check }) => {
    const { dispatcher, sent } = build([device()]);
    await dispatcher.kanbanEvents('marketing', events);
    if (check === null) {
      expect(sent.length).toBe(0);
      return;
    }
    expect(sent.length).toBe(1);
    const msg = sent[0]?.[0];
    if (msg) check(msg);
  });

  it('jobComplete pushes the summary', async () => {
    const { dispatcher, sent } = build([device()]);
    const job = {
      id: 'job-1',
      status: 'done',
      label: 'research',
      summary: 'wrote the report',
      personalityId: 'engineer',
    } as unknown as BackgroundJob;
    await dispatcher.jobComplete(job);
    const msg = sent[0]?.[0];
    expect(msg?.body).toContain('wrote the report');
    expect(msg?.data.category).toBe('runFinished');
  });

  it('jobComplete respects runFinished opt-out', async () => {
    const { dispatcher, sent } = build([device({ categories: { ...ALL_ON, runFinished: false } })]);
    const job = {
      id: 'job-1',
      status: 'done',
      label: 'research',
      summary: 'wrote the report',
      personalityId: 'engineer',
    } as unknown as BackgroundJob;
    await dispatcher.jobComplete(job);
    expect(sent.length).toBe(0);
  });

  it('category opt-out: approvals false sends nothing', async () => {
    const { dispatcher, sent } = build([device({ categories: { ...ALL_ON, approvals: false } })]);
    const request = {
      approvalId: 'appr-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: {},
      reason: null,
    };
    await dispatcher.approvalPending('sess-1', request, null);
    expect(sent.length).toBe(0);
  });

  it('fan-out sends one call with two messages', async () => {
    const { dispatcher, sent } = build([
      device(),
      device({ apiKeyId: 'key-2', expoPushToken: 'ExponentPushToken[bbb]' }),
    ]);
    const request = {
      approvalId: 'appr-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: {},
      reason: null,
    };
    await dispatcher.approvalPending('sess-1', request, null);
    expect(sent.length).toBe(1);
    expect(sent[0]?.length).toBe(2);
    expect(sent[0]?.map((m) => m.to)).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
  });

  it('test sends to the specified key', async () => {
    const { dispatcher, sent } = build([
      device(),
      device({ apiKeyId: 'key-2', expoPushToken: 'ExponentPushToken[bbb]' }),
    ]);
    const result = await dispatcher.test('key-2');
    expect(result).toEqual({ ok: true, sent: 1 });
    expect(sent.length).toBe(1);
    expect(sent[0]?.length).toBe(1);
    const msg = sent[0]?.[0];
    expect(msg?.to).toBe('ExponentPushToken[bbb]');
    expect(msg?.categoryId).toBe('approval');
    expect(String(msg?.data.approvalId)).toMatch(/^test-/);
    expect(msg?.data.test).toBe(true);
    expect(msg?.collapseId).toBe(msg?.data.approvalId);
  });

  it('test with no devices returns error', async () => {
    const { dispatcher, sent } = build([device()]);
    const result = await dispatcher.test('nobody');
    expect(result).toEqual({ ok: false, error: 'no registered device' });
    expect(sent.length).toBe(0);
  });

  it('start(): a real approval carries its deadline; its timeout sends the replacement; cron.failed arrives', async () => {
    const { dispatcher, sent } = build([device()]);
    const approvals = new ApprovalsService({
      allowlist: new AllowlistRepository({ dataDir: '/data', storage: new InMemoryStorage() }),
      timeoutMs: 50,
    });
    const systemBus = new SystemEventBus();
    const stop = dispatcher.start({ approvals, systemBus });
    const decision = approvals.requestApproval({
      sessionId: 'sess-9',
      toolCallId: 'tc-9',
      toolName: 'bash',
      args: { command: 'git push' },
    });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(Date.parse(String(sent[0]?.[0]?.data.deadline))).toBeGreaterThan(Date.now() - 1000);
    expect(await decision).toEqual({ decision: 'deny', reason: 'approval timed out' });
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]?.[0]?.collapseId).toBe(sent[0]?.[0]?.collapseId);
    expect(sent[1]?.[0]?.categoryId).toBeUndefined();

    systemBus.emitSystem({ type: 'cron.failed', jobId: 'j', jobName: 'nightly', error: 'boom' });
    await vi.waitFor(() => expect(sent.length).toBe(3));
    stop();
    systemBus.emitSystem({ type: 'cron.failed', jobId: 'j', jobName: 'nightly', error: 'again' });
    expect(sent.length).toBe(3);
  });

  it('test propagates transport failure', async () => {
    const failureResult: PushSendResult = {
      ok: false,
      error: 'Expo · 503 · project mitesh',
    };
    const { dispatcher } = build([device()], failureResult);
    const result = await dispatcher.test(undefined);
    expect(result).toEqual(failureResult);
  });
});
