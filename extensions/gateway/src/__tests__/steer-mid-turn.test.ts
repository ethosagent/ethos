// UBP-001 / UBP-012 (plan/phases/upstream-bug-parity.md) — a message sent while
// a turn is running is acked "↩ noted — I'll fold this into the answer I'm
// writing." That ack must be true.
//
// UBP-001: in a text-only turn there was no tool seam, so the steer was never
// drained; the sink was dropped at the terminal event and the steer's spool
// row closed `done` with the turn's (`cascadeAbsorbed`). AgentLoop now drains
// at text-end (D1, `foldTextEndSteers` in packages/core/src/agent-loop/steer.ts)
// and the gateway runs whatever is still queued when the turn ends as its own
// turn (`Gateway.requeueUnreadSteers`).
//
// UBP-012: a photo, PDF or voice note steered mid-turn reached the model as its
// `(attached image)` / `(voice message)` placeholder only. The gateway now
// pushes the bytes as blocks and transcribes a voice note before pushing.

import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultSttProviderRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { type SpoolRow, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  AttachmentCache,
  CompletionChunk,
  DeliveryResult,
  InboundMessage,
  LLMProvider,
  Message,
  OutboundMessage,
  PlatformAdapter,
  SteerEntry,
  Storage,
  SttProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { ABSORBED_STEER_ACK, Gateway, type GatewayConfig } from '../index';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
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

function rows(spool: SQLiteInboundSpool): SpoolRow[] {
  const db = (spool as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
  const ids = db.prepare('SELECT id FROM inbound_spool ORDER BY rowid').all() as Array<{
    id: string;
  }>;
  return ids.map(({ id }) => spool.get(id)).filter((r): r is SpoolRow => r !== null);
}

function gateway(loop: unknown, adapter: PlatformAdapter, extra: Partial<GatewayConfig> = {}) {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
}

function textOf(m: Message): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

/**
 * A text-only provider. The first call streams part of its answer and parks
 * until released — the user's second message lands while it is streaming.
 * Every call records the messages it was sent.
 */
function parkedTextLLM() {
  const calls: Message[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      calls.push(messages);
      if (calls.length === 1) {
        yield { type: 'text_delta', text: 'The capital of France is Paris.' };
        await gate;
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'text_delta', text: 'The capital of Germany is Berlin.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, calls, release: () => release() };
}

function realLoop(llm: LLMProvider): AgentLoop {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'default', name: 'Default', toolset: [] });
  return new AgentLoop({
    llm,
    tools: new DefaultToolRegistry(),
    session: new InMemorySessionStore(),
    personalities,
    safety: createTestSafety(),
    compaction: { autoCompact: false },
  });
}

describe('a steer in a text-only turn reaches the model (UBP-001, real AgentLoop)', () => {
  it('the second message is in an LLM call and the user gets an answer to it', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const scripted = parkedTextLLM();
    const out = recordingAdapter();
    const gw = gateway(realLoop(scripted.llm), out.adapter, {
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
    });

    const turn = gw.handleMessage(msg("what's the capital of France?"), out.adapter);
    await waitUntil(() => scripted.calls.length === 1);
    await gw.handleMessage(msg('and Germany?'), out.adapter);
    expect(out.sends).toEqual([ABSORBED_STEER_ACK]);

    scripted.release();
    await turn;

    // The steer was part of the second LLM call.
    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[1]?.map(textOf).join('\n')).toContain('and Germany?');
    // One reply, and it answers the steer.
    expect(out.sends).toHaveLength(2);
    expect(out.sends[1]).toContain('Berlin');
    // Both rows are done — the steer's because its text was in an LLM call.
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
  });
});

describe('a steer during the LAST call of a tool-using turn reaches the model (UBP-001)', () => {
  it('arrives after the final tool seam drained, and is in the next LLM call', async () => {
    const calls: Message[][] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const llm: LLMProvider = {
      name: 'scripted',
      model: 'scripted-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
        calls.push(messages);
        if (calls.length === 1) {
          yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'probe' };
          yield { type: 'tool_use_delta', toolCallId: 'c1', partialJson: '{}' };
          yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        if (calls.length === 2) {
          yield { type: 'text_delta', text: 'Probed.' };
          await gate;
          yield { type: 'done', finishReason: 'end_turn' };
          return;
        }
        yield { type: 'text_delta', text: 'And cc finance: done.' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'default', name: 'Default', toolset: ['probe'] });
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'probe',
      description: 'probe',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'probed' }),
    });
    const loop = new AgentLoop({
      llm,
      tools,
      session: new InMemorySessionStore(),
      personalities,
      safety: createTestSafety(),
      compaction: { autoCompact: false },
    });
    const out = recordingAdapter();
    const gw = gateway(loop, out.adapter);
    const turn = gw.handleMessage(msg('run the probe'), out.adapter);
    await waitUntil(() => calls.length === 2);
    await gw.handleMessage(msg('and cc finance on it'), out.adapter);
    release();
    await turn;
    expect(calls).toHaveLength(3);
    expect(calls[2]?.map(textOf).join('\n')).toContain('and cc finance on it');
    expect(out.sends.at(-1)).toContain('And cc finance: done.');
  });
});

type RunOpts = { abortSignal?: AbortSignal; steerSink?: { drainEntries?(): SteerEntry[] } };

/** A fake loop: records each turn's text; `impl` decides what it yields. */
function scriptedLoop(
  impl: (text: string, opts: RunOpts, n: number) => AsyncGenerator<Record<string, unknown>>,
) {
  const texts: string[] = [];
  const run = vi.fn((text: string, opts: RunOpts) => {
    texts.push(text);
    return impl(text, opts, texts.length);
  });
  return { loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } }, texts };
}

describe('a steer no seam read runs as its own turn (UBP-001)', () => {
  it('is re-queued on the lane with its own spool terminal, never closed unread', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Never drains: the steer is pushed after this loop's last seam.
    const s = scriptedLoop(async function* (_text, _opts, n) {
      if (n === 1) await gate;
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter, {
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
    });
    const turn = gw.handleMessage(msg('first'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    await gw.handleMessage(msg('and also this'), out.adapter);
    expect(rows(spool)[1]?.absorbedInto).toBe(rows(spool)[0]?.id);

    release();
    await turn;
    await waitUntil(() => s.texts.length === 2);
    expect(s.texts[1]).toContain('and also this');
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
    // Its own row, unlinked, so it got its own terminal.
    expect(rows(spool)[1]?.absorbedInto).toBeUndefined();
    expect(out.sends).toEqual([ABSORBED_STEER_ACK, 'reply 1', 'reply 2']);
  });

  it('a steer the loop DID read is not run again', async () => {
    const out = recordingAdapter();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = scriptedLoop(async function* (_text, opts, n) {
      if (n === 1) {
        await gate;
        opts.steerSink?.drainEntries?.();
      }
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter);
    const turn = gw.handleMessage(msg('first'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    await gw.handleMessage(msg('and also this'), out.adapter);
    release();
    await turn;
    await new Promise((r) => setTimeout(r, 20));
    expect(s.texts).toHaveLength(1);
  });

  it('/stop discards the unread steer with the turn, as it does every queued message', async () => {
    const out = recordingAdapter();
    const s = scriptedLoop(async function* (_text, opts, n) {
      if (n === 1) {
        await new Promise<void>((resolve) =>
          opts.abortSignal?.addEventListener('abort', () => resolve()),
        );
      }
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter);
    const turn = gw.handleMessage(msg('first'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    await gw.handleMessage(msg('and also this'), out.adapter);
    await gw.handleMessage(msg('/stop'), out.adapter);
    await turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(s.texts).toHaveLength(1);
  });
});

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

describe('a mid-turn attachment is steered with its bytes (UBP-012)', () => {
  /** A turn that parks, then drains its sink at a seam and records what it read. */
  function drainingLoop() {
    const drained: SteerEntry[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = scriptedLoop(async function* (_text, opts, n) {
      if (n === 1) {
        await gate;
        drained.push(...(opts.steerSink?.drainEntries?.() ?? []));
      }
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    return { ...s, drained, release: () => release() };
  }

  it('an image and a PDF reach the drain as image/document blocks', async () => {
    const out = recordingAdapter();
    const d = drainingLoop();
    const gw = gateway(d.loop, out.adapter);
    const turn = gw.handleMessage(msg('compare these'), out.adapter);
    await waitUntil(() => d.texts.length === 1);
    await gw.handleMessage(
      msg('(attached image)', {
        attachments: [
          {
            type: 'image',
            ref: 'a1',
            url: `data:image/png;base64,${PNG_BASE64}`,
            mimeType: 'image/png',
            filename: 'shot-2.png',
          },
          {
            type: 'file',
            ref: 'a2',
            url: `data:application/pdf;base64,${PNG_BASE64}`,
            mimeType: 'application/pdf',
            filename: 'spec.pdf',
          },
        ],
      }),
      out.adapter,
    );
    expect(out.sends).toContain(ABSORBED_STEER_ACK);
    d.release();
    await turn;
    expect(d.drained).toHaveLength(1);
    expect(d.drained[0]?.blocks).toEqual([
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64, filename: 'shot-2.png' },
      { type: 'document', mediaType: 'application/pdf', data: PNG_BASE64, filename: 'spec.pdf' },
    ]);
  });

  it('an image over the vision byte cap is not a block; the placeholder text stands', async () => {
    const out = recordingAdapter();
    const d = drainingLoop();
    const cache: AttachmentCache = {
      write: async () => 'file:///big.png',
      clear: async () => {},
      pruneOlderThan: async () => ({ removedCount: 0 }),
      resolveLocalPath: (url) => url.replace('file://', ''),
    };
    const storage = {
      readBytes: async () => new Uint8Array(6 * 1024 * 1024),
    } as unknown as Storage;
    const gw = gateway(d.loop, out.adapter, { attachmentCache: cache, storage });
    const turn = gw.handleMessage(msg('look'), out.adapter);
    await waitUntil(() => d.texts.length === 1);
    await gw.handleMessage(
      msg('(attached image)', {
        attachments: [{ type: 'image', ref: 'a1', url: 'file:///big.png', mimeType: 'image/png' }],
      }),
      out.adapter,
    );
    d.release();
    await turn;
    expect(d.drained[0]?.text).toBe('(attached image)');
    expect(d.drained[0]?.blocks ?? []).toEqual([]);
  });

  it('a voice note is transcribed before it is pushed', async () => {
    const out = recordingAdapter();
    const d = drainingLoop();
    const provider: SttProvider = {
      name: 'local-stt',
      caps: { kind: 'stt', formats: ['opus'], local: true, contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => 'also book the train',
    };
    const registry = new DefaultSttProviderRegistry();
    registry.register('local-stt', () => provider);
    const gw = gateway(d.loop, out.adapter, {
      attachmentCache: {
        write: async () => 'file:///note.ogg',
        clear: async () => {},
        pruneOlderThan: async () => ({ removedCount: 0 }),
        resolveLocalPath: (url) => url.replace('file://', ''),
      },
      storage: { readBytes: async () => Uint8Array.from([1, 2, 3]) } as unknown as Storage,
      sttProviderRegistry: registry,
      sttProviderName: 'local-stt',
    });
    const turn = gw.handleMessage(msg('book a table'), out.adapter);
    await waitUntil(() => d.texts.length === 1);
    await gw.handleMessage(
      msg('(voice message)', {
        attachments: [{ type: 'audio', ref: 'v1', url: 'file:///note.ogg', mimeType: 'audio/ogg' }],
      }),
      out.adapter,
    );
    d.release();
    await turn;
    expect(d.drained).toHaveLength(1);
    expect(d.drained[0]?.text).toContain('also book the train');
  });
});

// V-GC-4 — a steer with a voice note awaits STT before it is pushed, while a
// text-only steer pushes at once. A voice note followed quickly by a text on
// the same busy lane was steered text-first, and a turn that ended during the
// STT sent the voice note down the enqueue path, where `runTurn` transcribed it
// a second time.
describe('mid-turn voice notes keep arrival order and are transcribed once (V-GC-4)', () => {
  function gatedStt() {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const provider: SttProvider = {
      name: 'local-stt',
      caps: { kind: 'stt', formats: ['opus'], local: true, contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => {
        calls++;
        await gate;
        return 'also book the train';
      },
    };
    const registry = new DefaultSttProviderRegistry();
    registry.register('local-stt', () => provider);
    return { registry, calls: () => calls, release: () => release() };
  }

  const voiceConfig = (registry: DefaultSttProviderRegistry): Partial<GatewayConfig> => ({
    attachmentCache: {
      write: async () => 'file:///note.ogg',
      clear: async () => {},
      pruneOlderThan: async () => ({ removedCount: 0 }),
      resolveLocalPath: (url) => url.replace('file://', ''),
    },
    storage: { readBytes: async () => Uint8Array.from([1, 2, 3]) } as unknown as Storage,
    sttProviderRegistry: registry,
    sttProviderName: 'local-stt',
  });

  const voiceNote = () =>
    msg('(voice message)', {
      attachments: [{ type: 'audio', ref: 'v1', url: 'file:///note.ogg', mimeType: 'audio/ogg' }],
    });

  it('a voice note then a text are steered in arrival order', async () => {
    const out = recordingAdapter();
    const stt = gatedStt();
    const drained: SteerEntry[] = [];
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => {
      releaseTurn = r;
    });
    const s = scriptedLoop(async function* (_text, opts, n) {
      if (n === 1) {
        await turnGate;
        drained.push(...(opts.steerSink?.drainEntries?.() ?? []));
      }
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter, voiceConfig(stt.registry));
    const turn = gw.handleMessage(msg('book a table'), out.adapter);
    await waitUntil(() => s.texts.length === 1);

    const voice = gw.handleMessage(voiceNote(), out.adapter);
    await waitUntil(() => stt.calls() === 1);
    const text = gw.handleMessage(msg('for two people'), out.adapter);
    await new Promise((r) => setTimeout(r, 10));
    stt.release();
    await Promise.all([voice, text]);
    releaseTurn();
    await turn;

    expect(drained.map((e) => e.text)).toEqual([
      expect.stringContaining('also book the train'),
      'for two people',
    ]);
  });

  it('a turn that ends during the STT runs the voice note without transcribing it again', async () => {
    const out = recordingAdapter();
    const stt = gatedStt();
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => {
      releaseTurn = r;
    });
    const s = scriptedLoop(async function* (_text, _opts, n) {
      if (n === 1) await turnGate;
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter, voiceConfig(stt.registry));
    const turn = gw.handleMessage(msg('book a table'), out.adapter);
    await waitUntil(() => s.texts.length === 1);

    const voice = gw.handleMessage(voiceNote(), out.adapter);
    await waitUntil(() => stt.calls() === 1);
    releaseTurn();
    await turn;
    stt.release();
    await voice;
    await waitUntil(() => s.texts.length === 2);

    expect(s.texts[1]).toContain('also book the train');
    expect(stt.calls()).toBe(1);
  });

  // V2-RT-3 — a hung STT must not block the lane: the steer build is bounded
  // (`GatewayConfig.steerTranscribeTimeoutMs`), and on expiry the voice note
  // is steered as its placeholder text, as it was before UBP-012.
  it('a hung STT is steered as its placeholder text and does not hold the lane', async () => {
    const out = recordingAdapter();
    const stt = gatedStt(); // never released
    const drained: SteerEntry[] = [];
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => {
      releaseTurn = r;
    });
    const s = scriptedLoop(async function* (_text, opts, n) {
      if (n === 1) {
        await turnGate;
        drained.push(...(opts.steerSink?.drainEntries?.() ?? []));
      }
      yield { type: 'done', text: `reply ${n}`, turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter, {
      ...voiceConfig(stt.registry),
      steerTranscribeTimeoutMs: 20,
    });
    const turn = gw.handleMessage(msg('book a table'), out.adapter);
    await waitUntil(() => s.texts.length === 1);

    const voice = gw.handleMessage(voiceNote(), out.adapter);
    await waitUntil(() => stt.calls() === 1);
    const text = gw.handleMessage(msg('for two people'), out.adapter);
    await Promise.race([
      Promise.all([voice, text]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('lane held')), 1000)),
    ]);
    releaseTurn();
    await turn;

    expect(drained.map((e) => e.text)).toEqual(['(voice message)', 'for two people']);
  });
});
