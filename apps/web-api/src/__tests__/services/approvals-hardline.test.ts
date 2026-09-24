import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { hardlineReason } from '@ethosagent/wiring';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { LeaseRepository } from '../../repositories/lease.repository';
import { createWebApprovalHook } from '../../services/approval-hook';
import {
  type ApprovalObservability,
  type ApprovalRequestInput,
  ApprovalsService,
} from '../../services/approvals.service';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// openclaw-advisory-fixes Item 10 — the web profile registers no terminal /
// process guard hook, so the approval hook is the only gate for a hardline
// command. A human may approve ONE such call; what must never approve it is a
// stored answer — an allowlist grant or a one-hour lease on `terminal`.

const DATA = '/data';
const HARDLINE = { command: 'rm -rf /' };
const ORDINARY = { command: 'ls -la' };

type AuditRow = Parameters<ApprovalObservability['recordSafetyApproval']>[0];

describe('ApprovalsService — hardline calls are never decided by a stored answer', () => {
  let allowlist: AllowlistRepository;
  let leases: LeaseRepository;
  let approvals: ApprovalsService;
  let rows: AuditRow[];

  beforeEach(() => {
    const storage = new InMemoryStorage();
    rows = [];
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    leases = new LeaseRepository({ dataDir: DATA, storage });
    approvals = new ApprovalsService({
      allowlist,
      leases,
      timeoutMs: 0,
      observability: { recordSafetyApproval: (row) => rows.push(row) },
    });
  });

  function call(over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
    return {
      sessionId: 'sess_1',
      personalityId: 'A',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: ORDINARY,
      ...over,
    };
  }

  function hardlineCall(over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
    return call({ args: HARDLINE, reason: 'recursive force-delete', hardline: true, ...over });
  }

  function nextPending(): Promise<ApprovalRequest> {
    return new Promise((resolve) => {
      const off = approvals.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
  }

  /** The pending request `req` produced, or `null` when a stored answer
   *  settled it first. Decided by whichever happens first — no timer. */
  async function pendingFor(
    req: ApprovalRequestInput,
  ): Promise<{ request: ApprovalRequest; decision: Promise<unknown> } | null> {
    const pending = nextPending();
    const decision = approvals.requestApproval(req);
    const first = await Promise.race([decision.then(() => null), pending]);
    return first === null ? null : { request: first, decision };
  }

  async function grantAnyArgsTerminal(): Promise<void> {
    const p = await pendingFor(call());
    if (!p) throw new Error('expected a pending approval');
    await approvals.approve(p.request.approvalId, 'any-args', 'tab-A');
    await p.decision;
  }

  it('(a) an any-args terminal grant exists; a hardline terminal request still prompts', async () => {
    await grantAnyArgsTerminal();
    const p = await pendingFor(hardlineCall({ toolCallId: 'tc_h' }));
    expect(p).not.toBeNull();
    expect(p?.request.hardline).toBe(true);
    if (p) await approvals.deny(p.request.approvalId, undefined, 'tab-A');
  });

  it('(b) approving a hardline request with any-args / exact-args stores nothing', async () => {
    for (const scope of ['any-args', 'exact-args'] as const) {
      const p = await pendingFor(hardlineCall({ toolCallId: `tc_${scope}` }));
      if (!p) throw new Error('expected a pending approval');
      await approvals.approve(p.request.approvalId, scope, 'tab-A');
      // The human said yes to THIS call, so it runs…
      expect(await p.decision).toEqual({ decision: 'allow' });
      // …but no entry was written, and the downgrade is on the audit trail.
      expect(await allowlist.list()).toEqual([]);
      expect(rows.at(-1)).toMatchObject({
        decision: 'approved',
        details: { scope: 'once', requestedScope: scope, downgraded: 'hardline' },
      });
    }
    // And the next identical hardline call prompts again.
    const again = await pendingFor(hardlineCall({ toolCallId: 'tc_again' }));
    expect(again).not.toBeNull();
    if (again) await approvals.deny(again.request.approvalId, undefined, 'tab-A');
  });

  it('(c) a non-hardline terminal request still auto-allows from the grant', async () => {
    await grantAnyArgsTerminal();
    expect(await approvals.requestApproval(call({ toolCallId: 'tc_2' }))).toEqual({
      decision: 'allow',
    });
    expect(rows.at(-1)).toMatchObject({ decision: 'auto', details: { decidedBy: 'allowlist' } });
  });

  it('(d) an active terminal lease does not approve a hardline request', async () => {
    await leases.grant(
      { toolName: 'terminal', sessionId: 'sess_1', personalityId: 'A', grantedBy: 'tab-A' },
      3_600_000,
    );
    // The lease is live: an ordinary terminal call is auto-allowed by it…
    expect(await approvals.requestApproval(call())).toEqual({ decision: 'allow' });
    expect(rows.at(-1)).toMatchObject({ decision: 'auto', details: { decidedBy: 'lease' } });
    // …and a hardline one still reaches a human.
    const p = await pendingFor(hardlineCall({ toolCallId: 'tc_h' }));
    expect(p).not.toBeNull();
    if (p) await approvals.deny(p.request.approvalId, undefined, 'tab-A');
  });

  it("(e) approving a hardline request with 'lease-1h' grants no lease", async () => {
    const p = await pendingFor(hardlineCall());
    if (!p) throw new Error('expected a pending approval');
    await approvals.approve(p.request.approvalId, 'lease-1h', 'tab-A');
    expect(await p.decision).toEqual({ decision: 'allow' });
    expect(await leases.list()).toEqual([]);
    expect(rows.at(-1)).toMatchObject({
      details: { scope: 'once', requestedScope: 'lease-1h', downgraded: 'hardline' },
    });
    expect(rows.at(-1)?.details).not.toHaveProperty('leaseId');

    // The ordinary call that would have ridden that lease still prompts.
    const next = await pendingFor(call({ toolCallId: 'tc_2' }));
    expect(next).not.toBeNull();
    if (next) await approvals.deny(next.request.approvalId, undefined, 'tab-A');
  });

  it("(e') 'lease-1h' on a hardline request is downgraded even with no lease store wired", async () => {
    const noLeases = new ApprovalsService({ allowlist, timeoutMs: 0 });
    const pending = new Promise<ApprovalRequest>((resolve) => {
      const off = noLeases.onPending((_, r) => {
        off();
        resolve(r);
      });
    });
    const decision = noLeases.requestApproval(hardlineCall());
    await noLeases.approve((await pending).approvalId, 'lease-1h', 'tab-A');
    expect(await decision).toEqual({ decision: 'allow' });
  });
});

describe('createWebApprovalHook — marks a hardline call', () => {
  it('sends hardline: true only when isHardline says so', async () => {
    const seen: Array<boolean | undefined> = [];
    const spy = {
      requestApproval: async (req: ApprovalRequestInput) => {
        seen.push(req.hardline);
        return { decision: 'allow' as const };
      },
    } as unknown as ApprovalsService;
    const hook = createWebApprovalHook({
      approvals: spy,
      isDangerous: async () => 'gated',
      isHardline: (p) => hardlineReason(p) !== null,
    });
    const base = { sessionId: 's', toolCallId: 'tc', toolName: 'terminal' };
    await hook({ ...base, args: HARDLINE });
    await hook({ ...base, args: ORDINARY });
    await hook({ ...base, toolName: 'process_start', args: HARDLINE });
    expect(seen).toEqual([true, undefined, true]);
  });
});

// The wiring site: `createWebApi` is the one place the web approval hook is
// built (every host — `ethos serve`, `ethos boot`, desktop — goes through it),
// so it is where `isHardline` must be injected. Asserted through behaviour.
describe('createWebApi — injects the hardline check into the web approval hook', () => {
  it('a stored any-args terminal grant auto-allows `ls` but not `rm -rf /`', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ethos-approval-hardline-'));
    const store = new SQLiteSessionStore(':memory:');
    try {
      await writeFile(
        join(dir, 'allowlist.json'),
        JSON.stringify({
          entries: [
            {
              personalityId: 'A',
              toolName: 'terminal',
              scope: 'any-args',
              args: null,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );
      const loop = makeStubAgentLoop();
      createWebApi({
        dataDir: dir,
        sessionStore: store,
        memoryBundle: makeStubMemoryBundle(),
        agentLoop: loop,
        personalities: makeStubPersonalityRegistry(),
        chatDefaults: { model: 'claude-test', provider: 'anthropic' },
        approvalTimeoutMs: 30,
        dangerPredicate: async () => 'every terminal call requires approval (test rule)',
      });

      const fire = (args: unknown): Promise<Partial<BeforeToolCallResult>> =>
        loop.hooks.fireModifying('before_tool_call', {
          sessionId: 'sess_w',
          personalityId: 'A',
          toolCallId: 'tc_w',
          toolName: 'terminal',
          args,
        } satisfies BeforeToolCallPayload);

      expect((await fire(ORDINARY)).error).toBeUndefined();
      // Not allowlisted: it waits for a human and the 30ms window denies it.
      expect((await fire(HARDLINE)).error).toContain('approval timed out');
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
