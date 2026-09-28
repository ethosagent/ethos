// UBP-046 (plan/phases/upstream-bug-parity.md) — `/stop` during a pending
// approval used to abort only the lane: the turn stayed parked inside the
// `before_tool_call` hook until someone clicked the card or the 10-minute
// approval timeout fired, so the next message queued behind it and the card
// kept live Allow/Deny buttons. The gateway now tells its `/stop` listeners
// (`Gateway.onLaneStop`), and the approval surface settles the turn's pending
// approval as denied (`ApprovalCoordinator.cancelForSession`) — which is what
// updates the card (`onResolved`) and releases the lane.
//
// Real AgentLoop, real Gateway, real ApprovalCoordinator + approval hook. The
// first block subscribes the listener by hand, the way `wireApprovalFlow`
// (apps/ethos/src/commands/gateway.ts) does; the last case drives the
// production `wireApprovalFlow` itself — the path both `ethos gateway start`
// and `ethos boot` take — so dropping the subscription there fails a test.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { Gateway } from '@ethosagent/gateway';
import type {
  CompletionChunk,
  DeliveryResult,
  InboundMessage,
  LLMProvider,
  Message,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { ApprovalCoordinator, createSlackApprovalHook } from '../approval-coordinator';
import { wireApprovalFlow } from '../commands/gateway';

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(async () => {
  // `wireApprovalFlow`'s audit sink opens the process-wide observability store
  // lazily — keep it off the developer's real ~/.ethos.
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-stop-settles-approval-'));
  previousStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function lastText(messages: Message[]): string {
  const last = messages.at(-1);
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

/** Asks for `danger` on a fresh message; answers in text after a tool result. */
function toolAskingLLM(toolName = 'danger'): LLMProvider {
  let n = 0;
  return {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      n++;
      if (lastText(messages).includes('delete everything')) {
        const id = `call-${n}`;
        yield { type: 'tool_use_start', toolCallId: id, toolName };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: '{}' };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: `answer ${n}` };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function recordingAdapter() {
  const sends: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function msg(text: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text,
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
  };
}

function setup(opts: { subscribe: boolean }) {
  const ran = vi.fn(async () => ({ ok: true as const, value: 'deleted' }));
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'danger',
    description: 'needs approval',
    schema: { type: 'object' },
    capabilities: {},
    execute: ran,
  });
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'default', name: 'Default', toolset: ['danger'] });
  const loop = new AgentLoop({
    llm: toolAskingLLM(),
    tools,
    session: new InMemorySessionStore(),
    personalities,
    safety: createTestSafety(),
    compaction: { autoCompact: false },
  });
  // The 10-minute default: without the settle, nothing unparks the turn here.
  const coordinator = new ApprovalCoordinator();
  loop.hooks.registerModifying(
    'before_tool_call',
    createSlackApprovalHook({
      coordinator,
      isDangerous: async () => 'deletes files',
      resolveApprovalTarget: () => ({ requesterUserId: 'user-1' }),
      withoutSurface: async () => ({ error: 'no surface' }),
      hardlineReason: () => null,
    }),
  );
  const resolved: Array<{ decision: string; decidedBy: string }> = [];
  coordinator.onResolved((_id, decision, decidedBy) => resolved.push({ decision, decidedBy }));
  const out = recordingAdapter();
  const gw = new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([['telegram', out.adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
  if (opts.subscribe) {
    gw.onLaneStop(({ sessionId }) => coordinator.cancelForSession(sessionId, 'turn stopped'));
  }
  return { gw, coordinator, out, ran, resolved };
}

describe('/stop settles the turn’s pending approval (UBP-046)', () => {
  it('denies the card, runs nothing, and releases the lane within milliseconds', async () => {
    const { gw, coordinator, out, ran, resolved } = setup({ subscribe: true });
    const turn = gw.handleMessage(msg('delete everything'), out.adapter);
    await waitUntil(() => coordinator.pendingCount() === 1);

    const t0 = Date.now();
    await gw.handleMessage(msg('/stop'), out.adapter);
    await turn;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(coordinator.pendingCount()).toBe(0);
    // Settled as a deny by the system — the card's `onResolved` update fires.
    expect(resolved).toEqual([{ decision: 'deny', decidedBy: expect.any(String) }]);
    expect(ran).not.toHaveBeenCalled();
    expect(out.sends).toContain('✓ Stopped.');

    // The lane is free: the next message is answered, not queued for 10 min.
    await gw.handleMessage(msg('hello again'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/^answer \d+$/);
  });

  it('without the subscription the approval stays pending after /stop (the bug)', async () => {
    const { gw, coordinator, out } = setup({ subscribe: false });
    const turn = gw.handleMessage(msg('delete everything'), out.adapter);
    await waitUntil(() => coordinator.pendingCount() === 1);
    await gw.handleMessage(msg('/stop'), out.adapter);
    await new Promise((r) => setTimeout(r, 30));
    expect(coordinator.pendingCount()).toBe(1);
    // Clean up the parked turn.
    coordinator.forceSettleAll('test cleanup');
    await turn;
  });
});

describe('/stop through the production approval wiring (UBP-046)', () => {
  it('wireApprovalFlow subscribes to /stop: the card is denied and the lane released', async () => {
    // `call` is on the approval surface's always-ask list, so the real danger
    // predicate flags it without a provider or a personality policy.
    const ran = vi.fn(async () => ({ ok: true as const, value: 'called' }));
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'call',
      description: 'always asks',
      schema: { type: 'object' },
      capabilities: {},
      execute: ran,
    });
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'default', name: 'Default', toolset: ['call'] });
    const loop = new AgentLoop({
      llm: toolAskingLLM('call'),
      tools,
      session: new InMemorySessionStore(),
      personalities,
      safety: createTestSafety(),
      compaction: { autoCompact: false },
    });
    const out = recordingAdapter();
    const cardUpdates: string[] = [];
    let posted = 0;
    const adapter = Object.assign(out.adapter, {
      botKey: 'bot-a',
      postApprovalCard: async () => {
        posted++;
        return { messageTs: 'ts-1' };
      },
      updateApprovalCard: async (input: { decision: string }) => {
        cardUpdates.push(input.decision);
        return { ok: true };
      },
      onApprovalDecision: () => {},
    });
    const bots = [
      { botKey: 'bot-a', loop, binding: { type: 'personality' as const, name: 'default' } },
    ];
    const gw = new Gateway({
      bots,
      adapters: new Map([['telegram', adapter]]),
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    const flow = wireApprovalFlow(gw, bots, [adapter], {
      executionPostureFor: () => undefined,
      personalities,
      getProvider: async () => {
        throw new Error('the smart reviewer must not be constructed');
      },
      model: 'test-model',
      // No timeout: only the /stop subscription can unpark this turn.
      approvalTimeoutMs: 0,
      ownerFor: () => undefined,
    });

    const turn = gw.handleMessage(msg('delete everything'), adapter);
    await waitUntil(() => posted === 1 && flow.pendingCount() === 1);

    const t0 = Date.now();
    await gw.handleMessage(msg('/stop'), adapter);
    await turn;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(flow.pendingCount()).toBe(0);
    expect(ran).not.toHaveBeenCalled();
    await waitUntil(() => cardUpdates.length === 1);
    expect(cardUpdates).toEqual(['deny']);

    await gw.handleMessage(msg('hello again'), adapter);
    expect(out.sends.at(-1)).toMatch(/^answer \d+$/);
    await flow.shutdown();
  });
});
