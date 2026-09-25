// Plan openclaw-advisory-fixes L-c: who may decide a gateway approval.
// In a DM the requester decides; in a group the platform owner decides and the
// requester's own click is dropped; in a group whose platform has no owner
// configured the requester decides (D21). Drives the real `wireApprovalFlow`
// (and so the real `resolveApprovalTarget` + `ApprovalCoordinator.settle`)
// with a stub gateway route and an approval-capable adapter stub.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { Gateway, GatewayBotConfig } from '@ethosagent/gateway';
import type {
  ApprovalDecisionEvent,
  BeforeToolCallPayload,
  BeforeToolCallResult,
  PersonalityRegistry,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApprovalFlow } from '../gateway';

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(async () => {
  // The coordinator's audit sink opens the process-wide observability store
  // lazily — keep it off the developer's real ~/.ethos.
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-approval-target-'));
  previousStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

function wire(route: { isDm: boolean; platform: string }, owner: string | undefined) {
  let decide: (event: ApprovalDecisionEvent) => void = () => {};
  let signalPosted: (approvalId: string) => void = () => {};
  const posted = new Promise<string>((resolve) => {
    signalPosted = resolve;
  });
  const adapter = {
    id: 'slack:test',
    botKey: 'bot-1',
    postApprovalCard: async (card: { approvalId: string }) => {
      signalPosted(card.approvalId);
      return { messageTs: 'ts-1' };
    },
    updateApprovalCard: async () => ({ ok: true }),
    onApprovalDecision: (handler: (event: ApprovalDecisionEvent) => void) => {
      decide = handler;
    },
  } as unknown as PlatformAdapter;
  const hooks = new DefaultHookRegistry();
  const bots = [
    { botKey: 'bot-1', loop: { hooks }, binding: { type: 'personality', name: 'default' } },
  ] as unknown as GatewayBotConfig[];
  const gateway = {
    resolveApprovalRoute: () => ({
      adapter,
      chatId: 'C1',
      requesterUserId: 'requester',
      ...route,
    }),
  } as unknown as Gateway;
  const flow = wireApprovalFlow(gateway, bots, [adapter], {
    executionPostureFor: () => undefined,
    personalities: { get: () => undefined } as unknown as PersonalityRegistry,
    getProvider: async () => {
      throw new Error('no provider in this test');
    },
    model: 'test-model',
    approvalTimeoutMs: 0,
    ownerFor: (platform) => (platform === 'slack' ? owner : undefined),
  });
  const result: Promise<Partial<BeforeToolCallResult>> = hooks.fireModifying('before_tool_call', {
    sessionId: 'sid-1',
    toolCallId: 'tc-1',
    toolName: 'terminal',
    args: { command: 'kill $(lsof -t -i:3000)' },
  } satisfies BeforeToolCallPayload);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const click = (decidedBy: string, approvalId: string) =>
    decide({ approvalId, decision: 'allow', decidedBy } as ApprovalDecisionEvent);
  return { flow, posted, result, click, isSettled: () => settled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('approval target — owner in groups, requester in DMs (L-c)', () => {
  it('group with an owner: the requester cannot approve their own call; the owner can', async () => {
    const { flow, posted, result, click, isSettled } = wire(
      { isDm: false, platform: 'slack' },
      'owner',
    );
    const approvalId = await posted;

    click('requester', approvalId);
    await tick();
    expect(isSettled()).toBe(false);

    click('owner', approvalId);
    expect((await result).error).toBeUndefined();
    await flow.shutdown();
  });

  it('DM: the requester decides', async () => {
    const { flow, posted, result, click } = wire({ isDm: true, platform: 'slack' }, 'owner');
    const approvalId = await posted;

    click('requester', approvalId);
    expect((await result).error).toBeUndefined();
    await flow.shutdown();
  });

  it('DM: the owner is a bystander and cannot decide', async () => {
    const { flow, posted, click, isSettled } = wire({ isDm: true, platform: 'slack' }, 'owner');
    const approvalId = await posted;

    click('owner', approvalId);
    await tick();
    expect(isSettled()).toBe(false);
    await flow.shutdown();
  });

  it('group with no owner configured: the requester decides (D21)', async () => {
    const { flow, posted, result, click } = wire({ isDm: false, platform: 'slack' }, undefined);
    const approvalId = await posted;

    click('requester', approvalId);
    expect((await result).error).toBeUndefined();
    await flow.shutdown();
  });
});
