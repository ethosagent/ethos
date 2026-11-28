import type { AgentLoop } from '@ethosagent/core';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// plan telegram-live-cards L5 — the gateway posts `tool_end.structured.card` to a card-capable
// adapter (D3). It validates first, dedups per inbound message (D5), holds `recommend_actions`
// until the answer has been sent (D13), and owes no ledger obligation for a card (D4).
// ---------------------------------------------------------------------------

const alertCard = (message = 'Disk is full') => ({
  kind: 'alert',
  specVersion: 1,
  payload: { severity: 'warning', message },
});

const recommendCard = {
  kind: 'recommend_actions',
  specVersion: 1,
  payload: { question: 'Next?', actions: [{ label: 'Go', prompt: 'go on' }] },
};

function cardEnd(card: unknown, toolCallId = 'tc1'): AgentEvent {
  return {
    type: 'tool_end',
    toolCallId,
    toolName: 'emit_card',
    ok: true,
    durationMs: 1,
    result: 'rendered',
    structured: { card },
  };
}

const answerEvents = (text = 'the answer'): AgentEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', text, turnCount: 1 },
];

function loopYielding(events: AgentEvent[]) {
  return {
    run: vi.fn(async function* (_text: string, _opts?: Record<string, unknown>) {
      for (const e of events) yield e;
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function adapterWith(opts: { capable: boolean; postResult?: () => Promise<DeliveryResult> }) {
  const order: string[] = [];
  const posted: unknown[] = [];
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
      order.push(`send:${m.text}`);
      return { ok: true, messageId: 'm1' };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...(opts.capable
      ? {
          postCard: vi.fn(async (input: { card: { kind: string } }): Promise<DeliveryResult> => {
            order.push(`card:${input.card.kind}`);
            posted.push(input);
            return opts.postResult ? opts.postResult() : { ok: true, messageId: 'c1' };
          }),
        }
      : {}),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { order, posted });
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'show me',
    isDm: true,
    isGroupMention: false,
    messageId: `m${Math.random()}`,
    botKey: 'default',
    raw: {},
    ...over,
  };
}

function gatewayWith(loop: ReturnType<typeof loopYielding>, extra: Record<string, unknown> = {}) {
  return new Gateway({
    bots: [
      {
        botKey: 'default',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality' as const, name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    streamingEditIntervalMs: 0,
    ...extra,
  });
}

describe('Gateway card posting (D3)', () => {
  it('posts a valid data card at tool_end, before the final answer', async () => {
    const loop = loopYielding([cardEnd(alertCard()), ...answerEvents()]);
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order).toEqual(['card:alert', 'send:the answer']);
    expect(adapter.posted[0]).toMatchObject({ chatId: 'chat-1', card: alertCard() });
  });

  it('holds recommend_actions until the answer has been sent', async () => {
    const loop = loopYielding([
      cardEnd(alertCard(), 'a'),
      cardEnd(recommendCard, 'b'),
      ...answerEvents(),
    ]);
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order).toEqual(['card:alert', 'send:the answer', 'card:recommend_actions']);
  });

  it('does not post an invalid envelope, and records an observability event', async () => {
    const recordSafetyBlock = vi.fn();
    const loop = loopYielding([
      cardEnd({ kind: 'alert', specVersion: 1, payload: { severity: 'nope' } }),
      ...answerEvents(),
    ]);
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loop, { observability: { recordSafetyBlock } }).handleMessage(msg(), adapter);

    expect(adapter.order).toEqual(['send:the answer']);
    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'gateway.card_invalid' }),
    );
  });

  it('gives a non-capable adapter nothing: the prose is the answer', async () => {
    const loop = loopYielding([cardEnd(alertCard()), cardEnd(recommendCard), ...answerEvents()]);
    const adapter = adapterWith({ capable: false });

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order).toEqual(['send:the answer']);
  });

  it('ignores a failed tool_end and a tool_end with no card', async () => {
    const failed: AgentEvent = {
      type: 'tool_end',
      toolCallId: 'x',
      toolName: 'emit_card',
      ok: false,
      durationMs: 1,
      error: 'bad',
      structured: { card: alertCard() },
    };
    const noCard: AgentEvent = {
      type: 'tool_end',
      toolCallId: 'y',
      toolName: 'read_file',
      ok: true,
      durationMs: 1,
      structured: { _uiType: 'image' },
    };
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loopYielding([failed, noCard, ...answerEvents()])).handleMessage(
      msg(),
      adapter,
    );

    expect(adapter.order).toEqual(['send:the answer']);
  });
});

describe('Gateway card dedup (D5)', () => {
  it('posts an identical card for the same inbound message once', async () => {
    const loop = loopYielding([
      cardEnd(alertCard(), 'a'),
      cardEnd(alertCard(), 'b'),
      ...answerEvents(),
    ]);
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order.filter((o) => o === 'card:alert')).toHaveLength(1);
  });

  it('treats key order inside the envelope as the same card', async () => {
    const reordered = {
      payload: { message: 'Disk is full', severity: 'warning' },
      specVersion: 1,
      kind: 'alert',
    };
    const loop = loopYielding([
      cardEnd(alertCard(), 'a'),
      cardEnd(reordered, 'b'),
      ...answerEvents(),
    ]);
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order.filter((o) => o === 'card:alert')).toHaveLength(1);
  });

  it('still posts an identical card answering a different inbound message', async () => {
    const loop = loopYielding([cardEnd(alertCard()), ...answerEvents()]);
    const adapter = adapterWith({ capable: true });
    const gw = gatewayWith(loop);

    await gw.handleMessage(msg({ messageId: 'one' }), adapter);
    await gw.handleMessage(msg({ messageId: 'two' }), adapter);

    expect(adapter.order.filter((o) => o === 'card:alert')).toHaveLength(2);
  });

  it('a failed post releases the reservation so the same card can post again', async () => {
    let calls = 0;
    const adapter = adapterWith({
      capable: true,
      postResult: async () => (++calls === 1 ? { ok: false, error: 'boom' } : { ok: true }),
    });
    const loop = loopYielding([
      cardEnd(alertCard(), 'a'),
      cardEnd(alertCard(), 'b'),
      ...answerEvents(),
    ]);

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order.filter((o) => o === 'card:alert')).toHaveLength(2);
  });
});

describe('Gateway card posting never costs the answer (D4)', () => {
  it('a post that throws still lets the answer land, and records the failure', async () => {
    const recordSafetyBlock = vi.fn();
    const adapter = adapterWith({
      capable: true,
      postResult: async () => {
        throw new Error('network down');
      },
    });
    const loop = loopYielding([cardEnd(alertCard()), ...answerEvents()]);

    await gatewayWith(loop, { observability: { recordSafetyBlock } }).handleMessage(msg(), adapter);

    expect(adapter.order).toContain('send:the answer');
    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'gateway.card_post_failed' }),
    );
  });

  it('drops a held recommend_actions when the turn errored', async () => {
    const loop = loopYielding([
      cardEnd(recommendCard),
      { type: 'error', error: 'provider down', code: 'provider_error' },
    ]);
    const adapter = adapterWith({ capable: true });

    await gatewayWith(loop).handleMessage(msg(), adapter);

    expect(adapter.order.some((o) => o.startsWith('card:'))).toBe(false);
  });
});

describe('Gateway tool exclusion per adapter', () => {
  it('a card-capable adapter keeps emit_card; render_ui stays excluded', async () => {
    const loop = loopYielding(answerEvents());

    await gatewayWith(loop).handleMessage(msg(), adapterWith({ capable: true }));

    expect(loop.run.mock.calls[0]?.[1]?.toolsetExclude).toEqual(['render_ui']);
  });

  it('any other adapter still excludes both UI tools', async () => {
    const loop = loopYielding(answerEvents());

    await gatewayWith(loop).handleMessage(msg(), adapterWith({ capable: false }));

    expect(loop.run.mock.calls[0]?.[1]?.toolsetExclude).toEqual(['emit_card', 'render_ui']);
  });
});
