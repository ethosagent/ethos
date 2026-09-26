import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import {
  type ApprovalObservability,
  type ApprovalRequestInput,
  ApprovalsService,
} from '../../services/approvals.service';

// openclaw-advisory-fixes Item 5 — a web allowlist grant is bound to the
// personality whose call it approved. Before the fix an any-args `terminal`
// grant recorded for one personality auto-allowed that tool for every other
// personality that later requested approval through the same service.

const DATA = '/data';
const FILE = join(DATA, 'allowlist.json');

type AuditRow = Parameters<ApprovalObservability['recordSafetyApproval']>[0];

describe('ApprovalsService — allowlist is scoped by personality', () => {
  let storage: InMemoryStorage;
  let allowlist: AllowlistRepository;
  let approvals: ApprovalsService;
  let rows: AuditRow[];

  beforeEach(() => {
    storage = new InMemoryStorage();
    rows = [];
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    approvals = new ApprovalsService({
      allowlist,
      timeoutMs: 0,
      observability: { recordSafetyApproval: (row) => rows.push(row) },
    });
  });

  function nextPending(): Promise<ApprovalRequest> {
    return new Promise((resolve) => {
      const off = approvals.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
  }

  function call(over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
    return {
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'ls' },
      ...over,
    };
  }

  /** Request, then approve with `scope`, returning once the call resolves. */
  async function grant(req: ApprovalRequestInput, scope: 'any-args' | 'exact-args') {
    const pending = nextPending();
    const decision = approvals.requestApproval(req);
    await approvals.approve((await pending).approvalId, scope, 'tab-A');
    expect(await decision).toEqual({ decision: 'allow' });
  }

  /** True when `req` created a pending approval (then denied, to unblock).
   *  An allowlist hit settles the decision without ever emitting `pending`,
   *  so whichever of the two happens first answers the question — no timer. */
  async function prompts(req: ApprovalRequestInput): Promise<boolean> {
    const pending = nextPending();
    const decision = approvals.requestApproval(req);
    const first = await Promise.race([decision.then(() => null), pending.then((r) => r)]);
    if (first === null) return false;
    await approvals.deny(first.approvalId, undefined, 'tab-A');
    await decision;
    return true;
  }

  it("A's any-args grant does not auto-allow B, but does auto-allow A (audited `allowlist`)", async () => {
    await grant(call({ personalityId: 'A' }), 'any-args');

    const stored = await allowlist.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.personalityId).toBe('A');

    expect(await prompts(call({ personalityId: 'B', toolCallId: 'tc_b' }))).toBe(true);

    const decision = await approvals.requestApproval(
      call({ personalityId: 'A', toolCallId: 'tc_a2', args: { command: 'pwd' } }),
    );
    expect(decision).toEqual({ decision: 'allow' });
    expect(rows.at(-1)).toMatchObject({
      decision: 'auto',
      details: { toolCallId: 'tc_a2', decidedBy: 'allowlist' },
    });
  });

  it('an exact-args grant is scoped the same way', async () => {
    await grant(call({ personalityId: 'A' }), 'exact-args');
    expect(await prompts(call({ personalityId: 'B', toolCallId: 'tc_b' }))).toBe(true);
    expect(await approvals.requestApproval(call({ personalityId: 'A' }))).toEqual({
      decision: 'allow',
    });
  });

  it('a legacy entry with no personalityId never matches (D4) — and stays in the file', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      FILE,
      `${JSON.stringify({
        entries: [
          {
            toolName: 'terminal',
            scope: 'any-args',
            args: null,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      })}\n`,
    );
    expect(await allowlist.matches('A', 'terminal', { command: 'ls' })).toBe(false);
    expect(await prompts(call({ personalityId: 'A' }))).toBe(true);
    expect(await allowlist.list()).toHaveLength(1);
  });

  it('a request with no personalityId never matches, even an entry stored without one', async () => {
    await grant(call(), 'any-args');
    // The grant was recorded with no personality, so it can match nothing.
    expect((await allowlist.list())[0]?.personalityId).toBeUndefined();
    expect(await allowlist.matches(undefined, 'terminal', { command: 'ls' })).toBe(false);
    expect(await prompts(call({ toolCallId: 'tc_2' }))).toBe(true);
  });

  it('a pre-change allowlist.json still parses — readSafe does not reset it', async () => {
    const legacy = {
      entries: [
        { toolName: 'terminal', scope: 'any-args', args: null, createdAt: '2026-01-01T00:00:00Z' },
        {
          toolName: 'web_fetch',
          scope: 'exact-args',
          args: { url: 'https://a' },
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    };
    await storage.mkdir(DATA);
    await storage.write(FILE, `${JSON.stringify(legacy)}\n`);

    expect(await allowlist.list()).toEqual(legacy.entries);

    // A new grant appends beside the legacy entries rather than replacing them.
    await grant(call({ personalityId: 'A' }), 'any-args');
    const raw = await storage.read(FILE);
    const onDisk = JSON.parse(raw ?? '{}') as { entries: Array<Record<string, unknown>> };
    expect(onDisk.entries).toHaveLength(3);
    expect(onDisk.entries.slice(0, 2)).toEqual(legacy.entries);
    expect(onDisk.entries[2]).toMatchObject({ personalityId: 'A', toolName: 'terminal' });
  });
});
