// H2 (plan ux-feedback-and-config-clarity) — a tool call that runs 10s with no
// user-audience progress of its own gets "working on it (<tool>)…": on a
// streaming lane as the draft's single italic progress line (edited in place,
// design rule 3), on a non-streaming lane through H1's shared once-per-turn
// latch — one message per turn max, however many slow tools run (§9).

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

function scriptedLoop(script: Step[]) {
  const gates: Array<() => void> = [];
  const loop = {
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    run: vi.fn(() =>
      (async function* () {
        for (const step of script) {
          if (step === 'gate') await new Promise<void>((resolve) => gates.push(resolve));
          else yield step;
        }
      })(),
    ),
  };
  return {
    loop: loop as unknown as AgentLoop,
    release: () => {
      for (const open of gates.splice(0)) open();
    },
  };
}

function recordingAdapter(opts: { editable?: boolean } = {}) {
  const outbound: OutboundMessage[] = [];
  const edits: string[] = [];
  const base = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
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

function gatewayFor(loop: AgentLoop, adapter: PlatformAdapter, extra: Partial<GatewayConfig> = {}) {
  return new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([['telegram', adapter]]),
    streamingEditIntervalMs: 0,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
}

function msg(): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'run something slow',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: null,
  };
}

const toolStart = (id: string, name: string): AgentEvent => ({
  type: 'tool_start',
  toolCallId: id,
  toolName: name,
  args: {},
});
const toolEnd = (id: string, name: string): AgentEvent => ({
  type: 'tool_end',
  toolCallId: id,
  toolName: name,
  ok: true,
  durationMs: 1,
});

describe('tool activity line (H2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streaming lane: the line appears after 10s and the next text replaces it', async () => {
    const s = scriptedLoop([
      toolStart('t1', 'bash'),
      'gate',
      toolEnd('t1', 'bash'),
      { type: 'text_delta', text: 'Answer' },
      { type: 'done', text: 'Answer', turnCount: 1 },
    ]);
    const { adapter, outbound, edits } = recordingAdapter({ editable: true });
    const gw = gatewayFor(s.loop, adapter);
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(outbound).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    // The progress line is the draft's first flush — ONE message, no flood.
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.text).toContain('working on it (bash)');

    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    // The next text replaced the line in place (an edit, not a new message).
    expect(outbound).toHaveLength(1);
    expect(edits.at(-1)).toBe('Answer');
  });

  it("streaming lane: a tool's own user-audience progress suppresses the fallback line", async () => {
    const s = scriptedLoop([
      toolStart('t1', 'bash'),
      { type: 'tool_progress', toolName: 'bash', message: 'cloning the repo…', audience: 'user' },
      'gate',
      toolEnd('t1', 'bash'),
      { type: 'text_delta', text: 'Answer' },
      { type: 'done', text: 'Answer', turnCount: 1 },
    ]);
    const { adapter, outbound, edits } = recordingAdapter({ editable: true });
    const gw = gatewayFor(s.loop, adapter);
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(15_000);
    const all = [...outbound.map((m) => m.text), ...edits];
    expect(all.some((t) => t.includes('cloning the repo'))).toBe(true);
    expect(all.some((t) => t.includes('working on it'))).toBe(false);

    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(edits.at(-1)).toBe('Answer');
  });

  it('non-streaming lane: shares H1’s latch — one message per turn for three slow tools', async () => {
    const s = scriptedLoop([
      toolStart('t1', 'bash'),
      'gate',
      toolEnd('t1', 'bash'),
      toolStart('t2', 'web_search'),
      'gate',
      toolEnd('t2', 'web_search'),
      toolStart('t3', 'read_file'),
      'gate',
      toolEnd('t3', 'read_file'),
      { type: 'done', text: 'the answer', turnCount: 1 },
    ]);
    const { adapter, texts } = recordingAdapter();
    // H1's turn timer pushed out of the way: only H2's 10s per-tool timers
    // can fire, and they all funnel into the one shared latch.
    const gw = gatewayFor(s.loop, adapter, { slowTurnNoticeMs: 60_000 });
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(12_000);
      s.release();
    }
    await vi.advanceTimersByTimeAsync(1);
    await turn;

    expect(texts().filter((t) => t.startsWith('_working on it'))).toEqual([
      '_working on it · bash…_',
    ]);
    expect(texts().at(-1)).toBe('the answer');
  });

  it('a fast tool arms and cancels — no line on either kind of lane', async () => {
    const s = scriptedLoop([
      toolStart('t1', 'bash'),
      toolEnd('t1', 'bash'),
      'gate',
      { type: 'done', text: 'quick', turnCount: 1 },
    ]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter, { slowTurnNoticeMs: 60_000 });
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(texts()).toEqual([]);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts()).toEqual(['quick']);
  });

  it('an internal (in-script) tool_start never earns a line', async () => {
    const s = scriptedLoop([
      {
        type: 'tool_start',
        toolCallId: 'p1#1',
        toolName: 'bash',
        args: {},
        audience: 'internal',
      },
      'gate',
      { type: 'tool_end', toolCallId: 'p1#1', toolName: 'bash', ok: true, durationMs: 1 },
      { type: 'done', text: 'done inside', turnCount: 1 },
    ]);
    const { adapter, texts } = recordingAdapter();
    const gw = gatewayFor(s.loop, adapter, { slowTurnNoticeMs: 60_000 });
    const turn = gw.handleMessage(msg(), adapter);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(texts()).toEqual([]);
    s.release();
    await vi.advanceTimersByTimeAsync(1);
    await turn;
    expect(texts()).toEqual(['done inside']);
  });
});
