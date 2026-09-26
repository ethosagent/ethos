// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a displayed
// answer is not a finished iterator.
//
// `AgentLoop.run()` yields `done` BEFORE its turn-end work:
// `maybeConsolidateAtTurnEnd` (packages/core/src/agent-loop/turn-end.ts) calls
// the context engine's `onTurnComplete`, then the memory flush and
// auto-compaction. A consumer that `break`s on `done` calls the generator's
// `return()` and none of that runs. The gateway did exactly that on every turn.
//
// These tests drive a REAL AgentLoop through a real Gateway. A scripted loop
// that ends at `done` (the `gatedLoop` in live-adapters.test.ts) cannot catch
// this: it has no tail to skip. The context engine's turn-complete callback
// parks on a gate the test controls, so "the tail is still running" is an
// observable state rather than a race.

import {
  AgentLoop,
  DefaultContextEngineRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type { BackgroundExecutor } from '@ethosagent/job-runner';
import type {
  AgentEvent,
  BackgroundJob,
  CompletionChunk,
  ContextEngine,
  DeliveryResult,
  InboundMessage,
  LLMProvider,
  Message,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { Gateway, type GatewayBotConfig, type GatewayConfig } from '../index';
import { fakeAdapter, inbound, recordingTts, stubLoop } from './voice-fakes';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Let every pending microtask and a few macrotasks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

/** A context engine whose turn-complete callback parks until released. */
function gatedEngine() {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const engine: ContextEngine = {
    name: 'gated',
    async compact(opts) {
      return { messages: opts.messages, notes: 'noop' };
    },
    async onTurnComplete(input) {
      calls.push(input.sessionMetadata.sessionKey);
      await new Promise<void>((resolve) => gates.push(resolve));
      return null;
    },
  };
  return {
    engine,
    calls,
    parked: () => gates.length,
    releaseAll: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

function lastUserText(messages: Message[]): string {
  const last = messages.at(-1);
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

/**
 * A scripted provider. Every turn answers `answer <n>`. With `tool`, the first
 * call of a turn asks for that tool (after a short text preamble, so a
 * streaming draft exists for progress to fold into) and the call that follows
 * the tool result answers; `preamble: false` drops the preamble. A user
 * message containing `HOLD` parks the call on `hold` — a turn that is in flight
 * but has NOT answered.
 */
function scriptedLLM(opts: { tool?: string; preamble?: boolean } = {}) {
  const state = { calls: 0, answers: 0 };
  let releaseHold: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      state.calls++;
      const last = lastUserText(messages);
      if (last.includes('HOLD')) await hold;
      const afterTool = last.includes('tool_result');
      if (opts.tool && !afterTool) {
        if (opts.preamble !== false) yield { type: 'text_delta', text: 'checking… ' };
        const id = `call-${state.calls}`;
        yield { type: 'tool_use_start', toolCallId: id, toolName: opts.tool };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: '{}' };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      state.answers++;
      yield { type: 'text_delta', text: `answer ${state.answers}` };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, state, releaseHold: () => releaseHold?.() };
}

/** Records every outbound body, sends and edits alike, per chat. */
function recordingAdapter(opts: { streaming?: boolean; typing?: boolean } = {}) {
  const sends: Array<{ chatId: string; text: string }> = [];
  const edits: Array<{ chatId: string; text: string }> = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: opts.typing === true,
    canEditMessage: opts.streaming === true,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push({ chatId, text: m.text });
      return { ok: true, messageId: String(nextId++) };
    }),
    ...(opts.typing ? { sendTyping: vi.fn().mockResolvedValue(undefined) } : {}),
    ...(opts.streaming
      ? {
          editMessage: vi.fn(
            async (chatId: string, messageId: string, text: string): Promise<DeliveryResult> => {
              edits.push({ chatId, text });
              return { ok: true, messageId };
            },
          ),
        }
      : {}),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return {
    adapter,
    sends,
    edits,
    sentTo: (chatId: string) => sends.filter((s) => s.chatId === chatId).map((s) => s.text),
  };
}

function harness(
  opts: {
    tool?: boolean;
    /** A `returnDirect` tool — asked for bare, or after a streamed preamble. */
    returnDirect?: boolean | 'preamble';
    streaming?: boolean;
    typing?: boolean;
    gateway?: Partial<GatewayConfig>;
    bot?: Partial<GatewayBotConfig>;
    /** Share one transcript across two harnesses — a process restart. */
    session?: InMemorySessionStore;
  } = {},
) {
  const gate = gatedEngine();
  const contextEngines = new DefaultContextEngineRegistry();
  contextEngines.register(gate.engine);
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({
    id: 'default',
    name: 'Default',
    toolset: opts.tool ? ['probe'] : opts.returnDirect ? ['lookup'] : [],
    context_engine: 'gated',
  });
  const tools = new DefaultToolRegistry();
  if (opts.tool) {
    tools.register({
      name: 'probe',
      description: 'emits one progress line per audience',
      schema: { type: 'object' },
      capabilities: {},
      execute: async (_args, ctx) => {
        // Default audience is 'internal' — framework-only, never a surface's.
        ctx.emit({ type: 'progress', toolName: 'probe', message: 'INTERNAL-STEP' });
        ctx.emit({ type: 'progress', toolName: 'probe', message: 'USER-STEP', audience: 'user' });
        return { ok: true, value: 'probed' };
      },
    });
  }
  if (opts.returnDirect) {
    tools.register({
      name: 'lookup',
      description: 'answers directly, skipping LLM synthesis',
      schema: { type: 'object' },
      capabilities: {},
      returnDirect: true,
      execute: async () => ({ ok: true, value: 'DIRECT ANSWER' }),
    });
  }
  const scripted = scriptedLLM(
    opts.tool
      ? { tool: 'probe' }
      : opts.returnDirect
        ? { tool: 'lookup', preamble: opts.returnDirect === 'preamble' }
        : {},
  );
  const loop = new AgentLoop({
    llm: scripted.llm,
    tools,
    session: opts.session ?? new InMemorySessionStore(),
    personalities,
    contextEngines,
    safety: createTestSafety(),
    // Maintenance OFF. The engine callback is a contract with the framework,
    // not a feature of compaction — it must fire regardless.
    compaction: { autoCompact: false },
  });
  const out = recordingAdapter({ streaming: opts.streaming, typing: opts.typing });
  const gw = new Gateway({
    bots: [
      { botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' }, ...opts.bot },
    ],
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    streamingEditIntervalMs: 0,
    // A replay resolves its adapter from the registry (`adapterForBot`), and
    // `acceptInbound` spools only a message a replay could resolve one for —
    // so a spool-wired harness registers its adapter, as production wiring does.
    ...(opts.session || opts.gateway?.inboundSpool
      ? { adapters: new Map([['telegram', out.adapter]]) }
      : {}),
    ...opts.gateway,
  });
  return { gw, gate, scripted, out };
}

function msg(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
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
    ...overrides,
  };
}

describe('F07 — a gateway turn drains AgentLoop past `done`', () => {
  it('fires the context engine turn-complete callback, with maintenance off', async () => {
    const h = harness();
    const turn = h.gw.handleMessage(msg('first'), h.out.adapter);

    await waitUntil(() => h.gate.calls.length === 1);
    h.gate.releaseAll();
    await turn;

    expect(h.gate.calls).toHaveLength(1);
    expect(h.out.sentTo('chat-1')).toEqual(['answer 1']);
  });

  it('delivers the one final answer BEFORE the tail finishes — never waits on maintenance', async () => {
    const h = harness();
    const turn = h.gw.handleMessage(msg('first'), h.out.adapter);

    // The answer is out while the engine callback is still parked.
    await waitUntil(() => h.out.sends.length === 1 && h.gate.parked() === 1);
    expect(h.out.sentTo('chat-1')).toEqual(['answer 1']);
    // And the turn is still in flight: the tail holds it.
    expect(h.gw.hasActiveTurns()).toBe(true);

    h.gate.releaseAll();
    await turn;
    // Exactly one final — draining the tail sends nothing further.
    expect(h.out.sentTo('chat-1')).toEqual(['answer 1']);
    expect(h.gw.hasActiveTurns()).toBe(false);
  });

  it('holds the lane while the tail is parked — the next same-lane message waits for it', async () => {
    const h = harness();
    const first = h.gw.handleMessage(msg('first'), h.out.adapter);
    await waitUntil(() => h.out.sends.length === 1);

    const second = h.gw.handleMessage(msg('second'), h.out.adapter);
    await settle();
    // The second turn has not started (one LLM call so far), and the message
    // was not steered into the finished turn — no absorbed-steer ack, which
    // would have been an acknowledgement nobody ever read. It queued behind
    // the parked tail and said so (H3).
    expect(h.scripted.state.calls).toBe(1);
    expect(h.out.sentTo('chat-1')).toEqual([
      'answer 1',
      "⏳ queued (2nd) — I'll answer after the current reply.",
    ]);

    h.gate.releaseAll();
    await first;
    await waitUntil(() => h.gate.parked() === 1);
    expect(h.scripted.state.calls).toBe(2);
    expect(h.out.sentTo('chat-1')).toEqual([
      'answer 1',
      "⏳ queued (2nd) — I'll answer after the current reply.",
      'answer 2',
    ]);

    h.gate.releaseAll();
    await second;
    expect(h.gate.calls).toHaveLength(2);
  });

  // Chosen behaviour: shutdown sends the "interrupted, please resend" notice
  // only to chats whose answer has NOT landed — telling a user whose answer
  // already arrived to resend it would buy a duplicate turn — then waits, up to
  // `drainTimeoutMs`, for the aborted turns to unwind (see 'shutdown waits'
  // below). This tail ignores the abort, so shutdown returns at the bound with
  // it still parked; nothing it does afterwards can send a second reply.
  it('shutdown while the tail is parked: no resend notice for the answered chat, no second send', async () => {
    const h = harness();
    const answered = h.gw.handleMessage(msg('first'), h.out.adapter);
    await waitUntil(() => h.out.sends.length === 1 && h.gate.parked() === 1);

    // A second chat whose turn is in flight and has NOT answered.
    const unanswered = h.gw.handleMessage(msg('HOLD please', { chatId: 'chat-2' }), h.out.adapter);
    await waitUntil(() => h.scripted.state.calls === 2);

    await expect(
      h.gw.shutdown({ notify: 'INTERRUPTED', drainTimeoutMs: 50 }),
    ).resolves.toBeUndefined();

    expect(h.out.sentTo('chat-1')).toEqual(['answer 1']);
    expect(h.out.sentTo('chat-2')).toEqual(['INTERRUPTED']);

    h.gate.releaseAll();
    h.scripted.releaseHold();
    await expect(answered).resolves.toBeUndefined();
    await unanswered.catch(() => {});
    await settle();

    expect(h.out.sentTo('chat-1')).toEqual(['answer 1']);
    // The aborted turn delivers nothing after the notice.
    expect(h.out.sentTo('chat-2')).toEqual(['INTERRUPTED']);
  });

  // Inbound spool (plan reach-and-containment D2-6): `done` means drained AND
  // joined. A row marked done at the `done` event would be lost to a crash in
  // the tail — the memory flush the tail exists to run.
  it('the spool row stays processing through the parked tail; done only once it drains', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const h = harness({
      gateway: { inboundSpool: spool, inboundSpoolOptions: { replayIntervalMs: 0 } },
    });
    const turn = h.gw.handleMessage(msg('first'), h.out.adapter);

    await waitUntil(() => h.out.sends.length === 1 && h.gate.parked() === 1);
    expect(spool.stats()).toMatchObject({ processing: 1, done: 0 });

    h.gate.releaseAll();
    await turn;
    expect(spool.stats()).toMatchObject({ processing: 0, done: 1 });
  });

  // Plan openclaw-9.5-adoption D20 — a KNOWN, accepted behaviour, pinned so it
  // stays a decision: the crashed turn had already appended the user message
  // (AgentLoop persists it before the first LLM call), and `SessionStore` has
  // no delete-message method, so the replayed turn appends it a second time.
  // The model sees the same text twice with no reply between — harmless.
  it('a replay may duplicate the user message in the session transcript', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const session = new InMemorySessionStore();
    const gateway = { inboundSpool: spool, inboundSpoolOptions: { replayIntervalMs: 0 } };
    const first = harness({ session, gateway });
    void first.gw.handleMessage(msg('HOLD what is two plus two'), first.out.adapter);
    // The user message is in the transcript and the LLM call is parked: kill -9.
    await waitUntil(() => first.scripted.state.calls === 1);

    const second = harness({ session, gateway });
    second.scripted.releaseHold();
    await second.gw.replayInboundSpool();
    await waitUntil(() => second.gate.parked() === 1);
    second.gate.releaseAll();
    await waitUntil(() => spool.stats().done === 1);

    const [s] = await session.listSessions();
    const history = await session.getMessages(s?.id ?? '');
    const asked = history.filter(
      (m) => m.role === 'user' && m.content.includes('what is two plus two'),
    );
    expect(asked).toHaveLength(2);
    expect(second.out.sends.map((x) => x.text)).toEqual(['answer 1']);
  });

  it('keeps the tool-progress audience boundary: internal progress is never surfaced', async () => {
    const h = harness({ tool: true, streaming: true });
    const turn = h.gw.handleMessage(msg('probe it'), h.out.adapter);
    await waitUntil(() => h.gate.parked() === 1);
    h.gate.releaseAll();
    await turn;

    const everything = [...h.out.sends, ...h.out.edits].map((b) => b.text).join('\n');
    expect(everything).not.toContain('INTERNAL-STEP');
    // The gate filters by audience; it does not block progress wholesale.
    expect(everything).toContain('USER-STEP');
    // One streamed message, finalized in place by edit.
    expect(h.out.sends).toHaveLength(1);
    expect(h.out.edits.at(-1)?.text.endsWith('answer 1')).toBe(true);
    expect(h.gate.calls).toHaveLength(1);
  });
});

// Scripted, because a real AgentLoop cannot be made to yield after `done` on
// demand. What the tail yields (a turn-end compaction notice is
// `audience: 'user'`) is drained, not rendered: the final already landed, and
// rendering it would be a second message after the answer.
describe('F07 — events after the terminal one are drained, not rendered', () => {
  it('does not fold a post-`done` progress line into the finalized draft', async () => {
    let tailFinished = false;
    const loop = {
      run: vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'the answer' };
        yield { type: 'done', text: 'the answer', turnCount: 1 };
        yield {
          type: 'tool_progress',
          toolName: '_compaction',
          message: 'POST-DONE-NOTICE',
          audience: 'user',
        };
        tailFinished = true;
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const out = recordingAdapter({ streaming: true });
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
      streamingEditIntervalMs: 0,
    });

    await gw.handleMessage(msg('hi'), out.adapter);

    expect(tailFinished).toBe(true);
    const everything = [...out.sends, ...out.edits].map((b) => b.text).join('\n');
    expect(everything).not.toContain('POST-DONE-NOTICE');
    // One message; whatever it last read is the answer.
    expect(out.sends).toHaveLength(1);
    expect((out.edits.at(-1) ?? out.sends[0])?.text).toBe('the answer');
  });
});

// ---------------------------------------------------------------------------
// F07 follow-ups
// ---------------------------------------------------------------------------

/** A scripted loop: `events`, then (optionally) a throw from the tail. */
function scriptedLoop(events: AgentEvent[], tail?: { throws?: string; onTail?: () => void }) {
  return {
    run: vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      for (const e of events) yield e;
      await Promise.resolve();
      tail?.onTail?.();
      if (tail?.throws) throw new Error(tail.throws);
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function scriptedGateway(
  loop: ReturnType<typeof scriptedLoop>,
  extra: Partial<GatewayConfig> = {},
): { gw: Gateway; blocks: Array<{ code?: string; details?: Record<string, unknown> }> } {
  const blocks: Array<{ code?: string; details?: Record<string, unknown> }> = [];
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    observability: {
      recordSafetyBlock: (e) => blocks.push(e),
      recordChannelAllow: () => {},
      recordChannelDeny: () => {},
    },
    ...extra,
  });
  return { gw, blocks };
}

describe('F07 follow-ups — the gateway turn tail', () => {
  it('stops the typing indicator at the terminal event, not when the tail ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const h = harness({ typing: true });
      const turn = h.gw.handleMessage(msg('first'), h.out.adapter);
      await waitUntil(() => h.out.sends.length === 1 && h.gate.parked() === 1);
      const sendTyping = (h.out.adapter as unknown as { sendTyping: ReturnType<typeof vi.fn> })
        .sendTyping;
      const before = sendTyping.mock.calls.length;
      // Several typing periods (4 s each) while the tail is parked.
      vi.advanceTimersByTime(20_000);
      expect(sendTyping.mock.calls.length).toBe(before);
      h.gate.releaseAll();
      await turn;
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers a returnDirect tool result — the answer arrives only as `done.text`', async () => {
    const h = harness({ returnDirect: true });
    await h.gw.handleMessage(msg('look it up'), h.out.adapter);
    // A returnDirect turn yields `done` from processTools and ends — no
    // turn-end tail, and no text_delta for the answer.
    expect(h.out.sentTo('chat-1')).toEqual(['DIRECT ANSWER']);
  });

  // The model streamed a preamble, then called a returnDirect tool: the answer
  // is still only in `done.text` (`fullText` is the streamed text on every
  // other path). One final message carries both, in order.
  it('delivers a returnDirect answer that follows a streamed preamble — one final, both parts', async () => {
    const h = harness({ returnDirect: 'preamble' });
    await h.gw.handleMessage(msg('look it up'), h.out.adapter);
    expect(h.out.sentTo('chat-1')).toEqual(['checking… \n\nDIRECT ANSWER']);
  });

  it('streaming: the preamble draft is finalized in place with the answer — no second message', async () => {
    const h = harness({ returnDirect: 'preamble', streaming: true });
    await h.gw.handleMessage(msg('look it up'), h.out.adapter);
    expect(h.out.sends).toHaveLength(1);
    expect(h.out.edits.at(-1)?.text).toBe('checking… \n\nDIRECT ANSWER');
  });

  it('keeps draining after an `error` terminal event, and sends the error note once', async () => {
    let tailRan = false;
    const loop = scriptedLoop(
      [
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'model fell over', code: 'llm_error' },
      ],
      { onTail: () => (tailRan = true) },
    );
    const { gw } = scriptedGateway(loop);
    const out = recordingAdapter();
    await gw.handleMessage(msg('hi'), out.adapter);
    expect(tailRan).toBe(true);
    // A3 — the fold carries the chat-error map's title, not the raw string.
    expect(out.sentTo('chat-1')).toEqual([
      'partial\n\n⚠ Response interrupted: the model call failed',
    ]);
  });

  it('a tail failure AFTER the answer is recorded, not thrown at the adapter', async () => {
    const loop = scriptedLoop(
      [
        { type: 'text_delta', text: 'the answer' },
        { type: 'done', text: 'the answer', turnCount: 1 },
      ],
      { throws: 'tail boom' },
    );
    const { gw, blocks } = scriptedGateway(loop);
    const out = recordingAdapter();

    await expect(gw.handleMessage(msg('hi'), out.adapter)).resolves.toBeUndefined();

    expect(out.sentTo('chat-1')).toEqual(['the answer']);
    const tail = blocks.find((b) => b.code === 'gateway.turn_tail_failed');
    expect(tail?.details?.error).toBe('tail boom');
  });

  it('a failure BEFORE the answer still rejects, as it always did', async () => {
    const loop = scriptedLoop([{ type: 'text_delta', text: 'half' }], { throws: 'early boom' });
    const { gw, blocks } = scriptedGateway(loop);
    const out = recordingAdapter();

    await expect(gw.handleMessage(msg('hi'), out.adapter)).rejects.toThrow('early boom');
    expect(out.sends).toHaveLength(0);
    expect(blocks.some((b) => b.code === 'gateway.turn_tail_failed')).toBe(false);
  });

  it('when delivery AND the tail both fail, neither error hides the other', async () => {
    const loop = scriptedLoop(
      [
        { type: 'text_delta', text: 'the answer' },
        { type: 'done', text: 'the answer', turnCount: 1 },
      ],
      { throws: 'tail boom' },
    );
    // The text lands, then the voice decision reads a store that is down, so
    // delivery itself rejects.
    const voiceModeStore = {
      get: async () => {
        throw new Error('store down');
      },
      set: async () => {},
    };
    const { gw, blocks } = scriptedGateway(loop, {
      voiceModeStore: voiceModeStore as unknown as GatewayConfig['voiceModeStore'],
    });
    const out = recordingAdapter();

    await expect(gw.handleMessage(msg('hi'), out.adapter)).rejects.toThrow('store down');
    const tail = blocks.find((b) => b.code === 'gateway.turn_tail_failed');
    expect(tail?.details?.error).toBe('tail boom');
  });

  it('a plugin adapter’s failed turn is recorded, never an unhandled rejection', async () => {
    let deliver: ((m: InboundMessage) => void) | undefined;
    const pluginAdapter = {
      ...recordingAdapter().adapter,
      id: 'plugchat',
      onMessage: (h: (m: InboundMessage) => void) => {
        deliver = h;
      },
      start: async () => {},
    } as unknown as PlatformAdapter;
    const loop = scriptedLoop([], { throws: 'early boom' });
    const { blocks } = scriptedGateway(loop, {
      pluginAdapters: new Map([['plugchat', () => pluginAdapter]]),
    });

    deliver?.(msg('hi', { platform: 'plugchat' }));
    await waitUntil(() => blocks.some((b) => b.code === 'gateway.inbound_error'));
    expect(blocks.find((b) => b.code === 'gateway.inbound_error')?.details?.error).toBe(
      'early boom',
    );
  });

  it('defers a background completion notice through the tail; it lands once the turn ends', async () => {
    const handlers: Array<(job: BackgroundJob) => void> = [];
    const executor = {
      owner: 'proc-1',
      nudge: vi.fn(),
      onComplete: (h: (job: BackgroundJob) => void) => {
        handlers.push(h);
        return () => {};
      },
    } as unknown as BackgroundExecutor;
    const out = recordingAdapter();
    const h = harness({
      bot: { backgroundExecutor: executor },
      gateway: { adapters: new Map([['telegram', out.adapter]]) },
    });
    const turn = h.gw.handleMessage(msg('first'), out.adapter);
    await waitUntil(() => out.sends.length === 1 && h.gate.parked() === 1);

    for (const fire of handlers) {
      fire({
        id: 'job-1',
        owner: 'proc-1',
        parentSessionKey: 'p',
        rootSessionKey: 'r',
        childSessionKey: 'c',
        depth: 1,
        status: 'done',
        prompt: 'x',
        summary: 'BG-DONE',
        spendUsd: 0,
        createdAt: Date.now(),
        originPlatform: 'telegram',
        originBotKey: 'bot-a',
        originChatId: 'chat-1',
      });
    }
    await settle();
    // The answer is out but the turn still holds the lane: no notice yet.
    expect(out.sentTo('chat-1')).toEqual(['answer 1']);

    h.gate.releaseAll();
    await turn;
    await waitUntil(() => out.sends.length === 2);
    expect(out.sentTo('chat-1')[1]).toContain('BG-DONE');
  });
});

// F06 follow-up — callers dispose each bot's loop right after `shutdown()`
// returns, so shutdown waits (bounded) for the turns it aborted to unwind —
// drained turn-end tails included — instead of returning with them live.
describe('Gateway.shutdown waits for the turns it aborted', () => {
  /** A turn that parks until aborted, then takes `unwindMs` to unwind — or,
   *  with `'ignore'`, does not observe the abort at all until released. */
  function abortableLoop(unwindMs: number | 'ignore') {
    const state = { started: 0, finished: 0 };
    const gates: Array<() => void> = [];
    const loop = {
      run: vi.fn(async function* (
        _text: string,
        opts: { abortSignal: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        state.started++;
        await new Promise<void>((resolve) => {
          gates.push(resolve);
          if (unwindMs !== 'ignore') {
            opts.abortSignal.addEventListener('abort', () => setTimeout(resolve, unwindMs), {
              once: true,
            });
          }
        });
        state.finished++;
        yield { type: 'done', text: '', turnCount: 1 };
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    return {
      loop: loop as unknown as AgentLoop,
      state,
      release: () => {
        while (gates.length) gates.shift()?.();
      },
    };
  }

  function gatewayOn(loop: AgentLoop): Gateway {
    return new Gateway({
      bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
  }

  it('resolves only once an aborted turn has unwound — promptly when it does', async () => {
    const l = abortableLoop(30);
    const gw = gatewayOn(l.loop);
    const out = recordingAdapter();
    const turn = gw.handleMessage(msg('hi'), out.adapter).catch(() => {});
    await waitUntil(() => l.state.started === 1);

    const t0 = Date.now();
    await gw.shutdown({ notify: 'INTERRUPTED' });

    expect(l.state.finished).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
    // The existing notice behaviour is unchanged: an unanswered turn is told.
    expect(out.sentTo('chat-1')).toEqual(['INTERRUPTED']);
    await turn;
  });

  // Verifier scenario (e). Adapters keep delivering until shutdown returns —
  // the callers stop them afterwards — so inbound arrives DURING the drain.
  // It must start no turn (the loop is disposed right after) and must not be
  // "↩ noted" into the aborted turn's steer sink, where nobody reads it. It
  // gets the same "please resend" notice an interrupted turn gets — once per
  // chat — because that is literally what happened to it.
  it('refuses inbound during the drain: no new turn, no steer, one resend notice per chat', async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const loop = {
      run: vi.fn(async function* (text: string): AsyncGenerator<AgentEvent> {
        started.push(text);
        // Ignores the abort, so the drain runs to its bound.
        if (text.includes('slow')) await new Promise<void>((r) => gates.push(r));
        yield { type: 'text_delta', text: 'reply' };
        yield { type: 'done', text: 'reply', turnCount: 1 };
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const gw = gatewayOn(loop as unknown as AgentLoop);
    const out = recordingAdapter();
    const slow = gw.handleMessage(msg('slow'), out.adapter).catch(() => {});
    await waitUntil(() => started.length === 1);

    const stopping = gw.shutdown({ notify: 'RESEND', drainTimeoutMs: 200 });
    await settle();
    await gw.handleMessage(msg('late same chat'), out.adapter);
    await gw.handleMessage(msg('late other chat', { chatId: 'chat-2' }), out.adapter);
    await stopping;
    for (const g of gates) g();
    await slow;
    await settle();

    expect(started).toHaveLength(1);
    expect(out.sentTo('chat-1')).toEqual(['RESEND']);
    expect(out.sentTo('chat-2')).toEqual(['RESEND']);
  });

  it('without a notify text, inbound during the drain is dropped silently', async () => {
    const l = abortableLoop('ignore');
    const gw = gatewayOn(l.loop);
    const out = recordingAdapter();
    const turn = gw.handleMessage(msg('hi'), out.adapter).catch(() => {});
    await waitUntil(() => l.state.started === 1);
    const stopping = gw.shutdown({ drainTimeoutMs: 100 });
    await settle();
    await gw.handleMessage(msg('late', { chatId: 'chat-2' }), out.adapter);
    await stopping;
    l.release();
    await turn;
    expect(l.state.started).toBe(1);
    expect(out.sends).toHaveLength(0);
  });

  // The single-bot degrade path (`gateway.unknown_botKey`): a message whose
  // botKey names no bot is routed to the sole bot, and its lane is keyed by
  // THAT bot. The refusal has to derive the key the same way, or the chat is
  // told to resend twice — once for its in-flight turn, once for the message.
  it('tells a chat whose botKey degraded to the default bot exactly once', async () => {
    const l = abortableLoop('ignore');
    const gw = gatewayOn(l.loop);
    const out = recordingAdapter();
    const stale = { botKey: 'a-key-no-bot-answers-to' };
    const turn = gw.handleMessage(msg('hi', stale), out.adapter).catch(() => {});
    await waitUntil(() => l.state.started === 1);

    const stopping = gw.shutdown({ notify: 'RESEND', drainTimeoutMs: 100 });
    await settle();
    await gw.handleMessage(msg('late', stale), out.adapter);
    await stopping;
    l.release();
    await turn;

    expect(out.sentTo('chat-1')).toEqual(['RESEND']);
  });

  // The identical answer went out on this lane inside the dedup TTL, so the
  // chat HAS it — telling it to resend would be wrong even though this turn
  // sent nothing itself.
  it('a final the outbound dedup cache suppressed still counts as answered', async () => {
    let calls = 0;
    const gates: Array<() => void> = [];
    const loop = {
      run: vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        calls++;
        yield { type: 'text_delta', text: 'same answer' };
        yield { type: 'done', text: 'same answer', turnCount: 1 };
        // The second turn parks in its tail, so the shutdown lands there.
        if (calls === 2) await new Promise<void>((r) => gates.push(r));
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const gw = gatewayOn(loop as unknown as AgentLoop);
    const out = recordingAdapter();

    await gw.handleMessage(msg('one'), out.adapter);
    const second = gw.handleMessage(msg('two'), out.adapter);
    await waitUntil(() => calls === 2 && gates.length === 1);

    await gw.shutdown({ notify: 'RESEND', drainTimeoutMs: 50 });
    // One send: the first turn's. The second was suppressed, and the chat is
    // not told to resend what it already has.
    expect(out.sentTo('chat-1')).toEqual(['same answer']);

    for (const g of gates) g();
    await second;
  });

  it('gives up at the bound when a turn ignores the abort', async () => {
    const l = abortableLoop('ignore');
    const gw = gatewayOn(l.loop);
    const out = recordingAdapter();
    const turn = gw.handleMessage(msg('hi'), out.adapter).catch(() => {});
    await waitUntil(() => l.state.started === 1);

    const t0 = Date.now();
    await gw.shutdown({ drainTimeoutMs: 100 });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
    expect(l.state.finished).toBe(0);
    l.release();
    await turn;
  });

  // `drainTimeoutMs` bounds the whole call: a notice send that never settles
  // is left behind at the bound, and the drain does not get a fresh budget on
  // top of it.
  it('a hung notice send: shutdown still returns within one drain bound, and records it', async () => {
    const l = abortableLoop('ignore');
    const blocks: Array<{ code?: string; details?: Record<string, unknown> }> = [];
    const gw = new Gateway({
      bots: [{ botKey: 'bot-a', loop: l.loop, binding: { type: 'personality', name: 'default' } }],
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
      observability: {
        recordSafetyBlock: (o) => blocks.push(o),
        recordChannelAllow: () => {},
        recordChannelDeny: () => {},
      },
    });
    const out = recordingAdapter();
    out.adapter.send = vi.fn(() => new Promise<DeliveryResult>(() => {}));
    const turn = gw.handleMessage(msg('hi'), out.adapter).catch(() => {});
    await waitUntil(() => l.state.started === 1);

    const t0 = Date.now();
    await gw.shutdown({ notify: 'INTERRUPTED', drainTimeoutMs: 150 });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1_000);
    expect(blocks.find((b) => b.code === 'gateway.shutdown_notify_timeout')?.details).toEqual({
      stillPending: 1,
      timeoutMs: 150,
    });
    // The turn ignoring the abort is recorded too — with no time left to wait.
    expect(blocks.some((b) => b.code === 'gateway.shutdown_drain_timeout')).toBe(true);
    l.release();
    await turn;
  });
});

// Ported from the final-pass verifier's adversarial scenarios.
describe('F07 — verifier scenarios', () => {
  it('B and C queued behind A’s parked tail run in order, each with its own tail', async () => {
    const h = harness();
    const answers = () => h.out.sentTo('chat-1').filter((t) => t.startsWith('answer'));
    const a = h.gw.handleMessage(msg('A'), h.out.adapter);
    await waitUntil(() => h.out.sends.length === 1 && h.gate.parked() === 1);
    const b = h.gw.handleMessage(msg('B'), h.out.adapter);
    const c = h.gw.handleMessage(msg('C'), h.out.adapter);
    await settle();
    // H3 — each queued message is acked with its position; no answers yet
    // beyond A's.
    expect(h.out.sentTo('chat-1')).toEqual([
      'answer 1',
      "⏳ queued (2nd) — I'll answer after the current reply.",
      "⏳ queued (3rd) — I'll answer after the current reply.",
    ]);

    h.gate.releaseAll();
    await a;
    await waitUntil(() => answers().length === 2 && h.gate.parked() === 1);
    h.gate.releaseAll();
    await b;
    await waitUntil(() => answers().length === 3 && h.gate.parked() === 1);
    h.gate.releaseAll();
    await c;
    expect(answers()).toEqual(['answer 1', 'answer 2', 'answer 3']);
    expect(h.gate.calls).toHaveLength(3);
  });

  it('/stop during A’s parked tail drops B and C; the lane is not wedged — D runs after the tail', async () => {
    const h = harness();
    const a = h.gw.handleMessage(msg('A'), h.out.adapter);
    await waitUntil(() => h.out.sends.length === 1 && h.gate.parked() === 1);
    const b = h.gw.handleMessage(msg('B'), h.out.adapter).then(
      () => 'resolved',
      (e: Error) => `rejected:${e.message}`,
    );
    const c = h.gw.handleMessage(msg('C'), h.out.adapter).then(
      () => 'resolved',
      (e: Error) => `rejected:${e.message}`,
    );
    await settle();

    await h.gw.handleMessage(msg('/stop'), h.out.adapter);
    expect(await b).toBe('rejected:aborted');
    expect(await c).toBe('rejected:aborted');
    // The tail ignores the abort, so the lane is still held.
    expect(h.gate.parked()).toBe(1);

    const d = h.gw.handleMessage(msg('D'), h.out.adapter);
    await settle();
    expect(h.scripted.state.answers).toBe(1);
    h.gate.releaseAll();
    await a;
    await waitUntil(() => h.scripted.state.answers === 2 && h.gate.parked() === 1);
    h.gate.releaseAll();
    await d;
    expect(h.out.sentTo('chat-1')).toEqual([
      'answer 1',
      "⏳ queued (2nd) — I'll answer after the current reply.",
      "⏳ queued (3rd) — I'll answer after the current reply.",
      '✓ Stopped.',
      "⏳ queued (2nd) — I'll answer after the current reply.",
      'answer 2',
    ]);
  });

  for (const streaming of [false, true]) {
    it(`returnDirect after a preamble with a ledger (streaming=${streaming}): one final, nothing left to redeliver`, async () => {
      const ledger = new SQLiteDeliveryLedger(':memory:');
      const h = harness({
        returnDirect: 'preamble',
        streaming,
        gateway: { deliveryLedger: ledger },
      });
      await h.gw.handleMessage(msg('look it up'), h.out.adapter);

      expect(h.out.sends).toHaveLength(1);
      const final = streaming ? (h.out.edits.at(-1) ?? h.out.sends[0]) : h.out.sends[0];
      expect(final?.text).toBe('checking… \n\nDIRECT ANSWER');
      expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
      expect(await h.gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
      expect(h.out.sends).toHaveLength(1);
      ledger.close();
    });
  }
});

// A chat whose TEXT answer has landed has its answer, even while the voice
// note for it is still being synthesized — a shutdown in that window must not
// tell it to resend.
describe('F07 — answered means the text final landed, not the voice note', () => {
  it('no resend notice for a chat whose text answer landed while its voice note was being made', async () => {
    const tts = recordingTts('wav');
    let synthStarted = false;
    let releaseSynth: (() => void) | undefined;
    const synthGate = new Promise<void>((resolve) => {
      releaseSynth = resolve;
    });
    (tts.provider as { synthesize: typeof tts.provider.synthesize }).synthesize = async () => {
      synthStarted = true;
      await synthGate;
      return { audio: Uint8Array.from([1, 2, 3]), format: 'wav' as const };
    };
    const voice = fakeAdapter({ id: 'telegram:bot-a' });
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: stubLoop('the answer'),
          binding: { type: 'personality', name: 'default' },
        },
      ],
      ttsProviderRegistry: tts.registry,
      ttsProviderName: 'local-tts',
      defaultVoiceMode: 'all',
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });

    const turn = gw.handleMessage(inbound({ botKey: 'bot-a' }), voice.adapter).catch(() => {});
    await waitUntil(() => synthStarted);
    await gw.shutdown({ notify: 'RESEND', drainTimeoutMs: 50 });

    expect(voice.sent.map((s) => s.message.text)).toEqual(['the answer']);
    releaseSynth?.();
    await turn;
  });
});
