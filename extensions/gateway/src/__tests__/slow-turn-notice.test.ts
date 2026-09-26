// H1 (plan ux-feedback-and-config-clarity) — a non-streaming lane that has
// heard nothing for `slowTurnNoticeMs` gets ONE untracked
// "_working on it · <tool|thinking>…_" ack per turn. Never on streaming lanes
// (the draft is the feedback), never on email (UD9), cancelled by early text,
// disabled by `slowTurnNoticeMs: 0`. §9: one shared once-per-turn latch with
// H2's tool-activity fallback — three slow tools still produce one message.

import type { AgentLoop } from '@ethosagent/core';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';

type Step = AgentEvent | 'gate';

/** A loop that yields its script, parking at every 'gate' until released. */
function scriptedLoop(script: Step[]) {
  const gates: Array<() => void> = [];
  const state = { runs: 0 };
  const loop = {
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    run: vi.fn(() =>
      (async function* () {
        state.runs++;
        for (const step of script) {
          if (step === 'gate') await new Promise<void>((resolve) => gates.push(resolve));
          else yield step;
        }
      })(),
    ),
  };
  return {
    loop: loop as unknown as AgentLoop,
    state,
    release: () => {
      for (const open of gates.splice(0)) open();
    },
  };
}

function recordingAdapter(opts: { platform?: string; editable?: boolean } = {}) {
  const platform = opts.platform ?? 'telegram';
  const outbound: OutboundMessage[] = [];
  const edits: string[] = [];
  const base = {
    id: `${platform}:bot-a`,
    displayName: platform,
    capabilities: { platform },
    canSendTyping: false,
    canEditMessage: opts.editable ?? false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      outbound.push(m);
      return { ok: true, messageId: String(outbound.length) };
    }),
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
  const adapter = (opts.editable
    ? {
        ...base,
        editMessage: vi.fn(async (_c: string, _id: string, text: string) => {
          edits.push(text);
          return { ok: true, messageId: 'e1' };
        }),
      }
    : base) as unknown as PlatformAdapter;
  return { adapter, outbound, edits, texts: () => outbound.map((m) => m.text) };
}

function gatewayFor(
  loop: AgentLoop,
  adapter: PlatformAdapter,
  platform = 'telegram',
  extra: Partial<GatewayConfig> = {},
) {
  return new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([[platform, adapter]]),
    streamingEditIntervalMs: 0,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
}

function msg(platform = 'telegram', overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform,
    botKey: 'bot-a',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'do the slow thing',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: null,
    ...overrides,
  };
}

const NOTICE_THINKING = '_working on it · thinking…_';

const doneEvent: AgentEvent = { type: 'done', text: 'the answer', turnCount: 1 };

describe('slow-turn notice (H1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after 8s of silence, naming "thinking", then the answer lands', async () => {
    const s = scriptedLoop(['gate', doneEvent]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter);
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so the timers are armed at t=0

    await vi.advanceTimersByTimeAsync(7_999);
    expect(texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(texts()).toEqual([NOTICE_THINKING]);

    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts()).toEqual([NOTICE_THINKING, 'the answer']);
  });

  it('names the running tool, and three slow tools still yield ONE message (§9)', async () => {
    const s = scriptedLoop([
      { type: 'tool_start', toolCallId: 't1', toolName: 'bash', args: {} },
      'gate',
      { type: 'tool_end', toolCallId: 't1', toolName: 'bash', ok: true, durationMs: 1 },
      { type: 'tool_start', toolCallId: 't2', toolName: 'web_search', args: {} },
      'gate',
      { type: 'tool_end', toolCallId: 't2', toolName: 'web_search', ok: true, durationMs: 1 },
      { type: 'tool_start', toolCallId: 't3', toolName: 'read_file', args: {} },
      'gate',
      { type: 'tool_end', toolCallId: 't3', toolName: 'read_file', ok: true, durationMs: 1 },
      doneEvent,
    ]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter);
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so the timers are armed at t=0

    // Three slow tools, ~12s each — H1's 8s timer and H2's 10s timers all
    // pass, but the shared latch admits exactly one message.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(12_000);
      s.release();
    }
    await vi.advanceTimersByTimeAsync(1);
    await turn;

    const notices = texts().filter((t) => t.startsWith('_working on it'));
    expect(notices).toEqual(['_working on it · bash…_']);
    expect(texts().at(-1)).toBe('the answer');
  });

  it('is cancelled by early text', async () => {
    const s = scriptedLoop([{ type: 'text_delta', text: 'the answer' }, 'gate', doneEvent]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter);
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so the timers are armed at t=0

    await vi.advanceTimersByTimeAsync(20_000);
    expect(texts()).toEqual([]);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts()).toEqual(['the answer']);
  });

  it('never fires on a streaming lane — the draft is the feedback', async () => {
    const s = scriptedLoop([
      { type: 'text_delta', text: 'streamed' },
      'gate',
      { type: 'done', text: 'streamed', turnCount: 1 },
    ]);
    const { adapter, texts } = recordingAdapter({ editable: true });
    const gw = gatewayFor(s.loop, adapter);
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so the timers are armed at t=0

    await vi.advanceTimersByTimeAsync(20_000);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts().filter((t) => t.startsWith('_working on it'))).toEqual([]);
  });

  it('never fires on an email lane (UD9)', async () => {
    const s = scriptedLoop(['gate', doneEvent]);
    const { adapter, texts } = recordingAdapter({ platform: 'email' });
    const gw = gatewayFor(s.loop, adapter, 'email');
    const turn = gw.handleMessage(msg('email'), adapter);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(texts()).toEqual([]);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts()).toEqual(['the answer']);
  });

  it('slowTurnNoticeMs: 0 disables it entirely', async () => {
    const s = scriptedLoop([
      { type: 'tool_start', toolCallId: 't1', toolName: 'bash', args: {} },
      'gate',
      { type: 'tool_end', toolCallId: 't1', toolName: 'bash', ok: true, durationMs: 1 },
      doneEvent,
    ]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter, 'telegram', { slowTurnNoticeMs: 0 });
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so the timers are armed at t=0

    // Past H1's default AND H2's 10s tool timer: 0 turns both off on a
    // non-streaming lane (one knob for "may this lane get an unprompted ack").
    await vi.advanceTimersByTimeAsync(30_000);
    expect(texts()).toEqual([]);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts()).toEqual(['the answer']);
  });

  it('a custom interval is honoured', async () => {
    const s = scriptedLoop(['gate', doneEvent]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter, 'telegram', { slowTurnNoticeMs: 500 });
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so the timers are armed at t=0

    await vi.advanceTimersByTimeAsync(600);
    expect(texts()).toEqual([NOTICE_THINKING]);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
  });
});
