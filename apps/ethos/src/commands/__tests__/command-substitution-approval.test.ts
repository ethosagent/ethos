// Command substitution requires approval, not a hardline refusal. On a gateway
// bot loop the terminal guard (registered first, as `composeAllTools` does for
// a non-web profile) must leave `kill $(lsof -t -i:3000)` to the approval card
// that `wireApprovalFlow` registers — which marks the loop — and a bot with no
// card surface must still refuse it. `bash -c` stays hardline.
//
// apps/ethos does not depend on `@ethosagent/tools-terminal`, so the guard here
// is a stand-in with the real guard's decision (`hardlineReason`, then
// `approvalRequiredReason` unless `hasHostApprovalGate`). The real composed
// guard is pinned by packages/wiring/src/__tests__/command-substitution-guard.test.ts.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { Gateway, GatewayBotConfig } from '@ethosagent/gateway';
import type {
  ApprovalDecisionEvent,
  BeforeToolCallResult,
  PersonalityRegistry,
  PlatformAdapter,
} from '@ethosagent/types';
import { approvalRequiredReason, hardlineReason, hasHostApprovalGate } from '@ethosagent/wiring';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApprovalFlow } from '../gateway';

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-subst-approval-'));
  previousStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const seams = {
  executionPostureFor: () => undefined,
  personalities: { get: () => undefined } as unknown as PersonalityRegistry,
  getProvider: async () => {
    throw new Error('no provider in this test');
  },
  model: 'test-model',
  approvalTimeoutMs: 0,
  ownerFor: () => undefined,
};

function botLoopHooks(): DefaultHookRegistry {
  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_tool_call', async (payload) => {
    const hardline = hardlineReason(payload);
    if (hardline) return { error: `Command blocked: ${hardline}.` };
    const approval = approvalRequiredReason(payload);
    if (approval && !hasHostApprovalGate(hooks)) return { error: `Command blocked: ${approval}.` };
    return null;
  });
  return hooks;
}

function fire(hooks: DefaultHookRegistry, command: string): Promise<Partial<BeforeToolCallResult>> {
  return hooks.fireModifying('before_tool_call', {
    sessionId: 'sid-1',
    toolCallId: 'tc-1',
    toolName: 'terminal',
    args: { command },
  });
}

function wireCardBot() {
  let decide: (event: ApprovalDecisionEvent) => void = () => {};
  const cards: Array<{ approvalId: string; reason: string | null }> = [];
  let signalPosted: () => void = () => {};
  let posted = new Promise<void>((resolve) => {
    signalPosted = resolve;
  });
  const adapter = {
    id: 'slack:test',
    botKey: 'bot-1',
    postApprovalCard: async (card: { approvalId: string; reason: string | null }) => {
      cards.push(card);
      signalPosted();
      return { messageTs: 'ts-1' };
    },
    updateApprovalCard: async () => ({ ok: true }),
    onApprovalDecision: (handler: (event: ApprovalDecisionEvent) => void) => {
      decide = handler;
    },
  } as unknown as PlatformAdapter;
  const hooks = botLoopHooks();
  const bots = [
    { botKey: 'bot-1', loop: { hooks }, binding: { type: 'personality', name: 'default' } },
  ] as unknown as GatewayBotConfig[];
  const gateway = {
    resolveApprovalRoute: () => ({
      adapter,
      chatId: 'C1',
      requesterUserId: 'requester',
      isDm: true,
      platform: 'slack',
    }),
  } as unknown as Gateway;
  const flow = wireApprovalFlow(gateway, bots, [adapter], seams);
  const nextCard = async () => {
    await posted;
    posted = new Promise<void>((resolve) => {
      signalPosted = resolve;
    });
    const card = cards.at(-1);
    if (!card) throw new Error('no card posted');
    return card;
  };
  const click = (approvalId: string, decision: 'allow' | 'deny') =>
    decide({ approvalId, decision, decidedBy: 'requester' } as ApprovalDecisionEvent);
  return { hooks, flow, nextCard, click };
}

describe('gateway — command substitution asks on a card surface', () => {
  it('kill $(lsof -t -i:3000) posts an approval card and runs once allowed', async () => {
    const { hooks, flow, nextCard, click } = wireCardBot();
    expect(hasHostApprovalGate(hooks)).toBe(true);
    const result = fire(hooks, 'kill $(lsof -t -i:3000)');
    const card = await nextCard();
    expect(card.reason).toBe('terminal requires explicit approval (command substitution)');
    click(card.approvalId, 'allow');
    expect((await result).error).toBeUndefined();
    await flow.shutdown();
  });

  it('a denied card refuses it', async () => {
    const { hooks, flow, nextCard, click } = wireCardBot();
    const result = fire(hooks, 'git commit -m "$(cat msg)"');
    const card = await nextCard();
    click(card.approvalId, 'deny');
    expect((await result).error).toMatch(/command substitution/);
    await flow.shutdown();
  });

  it('bash -c stays hardline: the guard refuses it even when the card is allowed', async () => {
    const { hooks, flow, nextCard, click } = wireCardBot();
    const result = fire(hooks, "bash -c 'id'");
    const card = await nextCard();
    click(card.approvalId, 'allow');
    expect((await result).error).toMatch(/Command blocked: inline shell eval/);
    await flow.shutdown();
  });

  it('a bot with no card surface refuses it with the no-surface text', async () => {
    const hooks = botLoopHooks();
    const bots = [
      { botKey: 'bot-2', loop: { hooks }, binding: { type: 'personality', name: 'default' } },
    ] as unknown as GatewayBotConfig[];
    const gateway = { resolveApprovalRoute: () => undefined } as unknown as Gateway;
    const flow = wireApprovalFlow(gateway, bots, [], seams);
    expect(hasHostApprovalGate(hooks)).toBe(true);
    const result = await fire(hooks, 'kill $(lsof -t -i:3000)');
    expect(result.error).toMatch(/this chat surface cannot show an approval prompt/);
    expect(result.error).toMatch(/command substitution/);
    await flow.shutdown();
  });
});
