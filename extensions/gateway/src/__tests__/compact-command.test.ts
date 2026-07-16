import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// Phase 2 — `/compact` is parsed at the gateway and dispatched to the loop's
// manual-compaction method (never an agent turn), with a pre/post confirmation.

function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubLoop(compact: ReturnType<typeof vi.fn>) {
  return {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    compact,
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function makeMessage(text: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: '100',
    userId: '200',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: '1',
    botKey: 'test-bot',
    raw: {},
  };
}

function makeGateway(loop: ReturnType<typeof stubLoop>) {
  return new Gateway({
    bots: [
      {
        botKey: 'test-bot',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
  });
}

describe('Gateway — /compact', () => {
  it('dispatches /compact to loop.compact with the focus text and replies (no turn)', async () => {
    const compact = vi.fn().mockResolvedValue({
      ok: true,
      engineName: 'semantic_summary',
      droppedCount: 12,
      preTotalTokens: 5000,
      postTotalTokens: 900,
      summariesEnabled: true,
    });
    const loop = stubLoop(compact);
    const gw = makeGateway(loop);
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage('/compact the deploy bug'), adapter);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ instructions: 'the deploy bug' }),
    );
    expect(loop.run).not.toHaveBeenCalled();
    const reply = vi.mocked(adapter.send).mock.calls[0]?.[1] as { text: string };
    expect(reply.text).toContain('Compacted 12');
    expect(reply.text).toContain('5,000');
    expect(reply.text).toContain('900');
  });

  it('surfaces the enable-summaries hint when no summarizer is configured', async () => {
    const compact = vi.fn().mockResolvedValue({
      ok: true,
      engineName: 'drop_oldest',
      droppedCount: 3,
      preTotalTokens: 2000,
      postTotalTokens: 500,
      summariesEnabled: false,
    });
    const loop = stubLoop(compact);
    const adapter = stubAdapter();
    await makeGateway(loop).handleMessage(makeMessage('/compact'), adapter);

    expect(compact).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ instructions: expect.anything() }),
    );
    const reply = vi.mocked(adapter.send).mock.calls[0]?.[1] as { text: string };
    expect(reply.text).toContain('auxiliary.compression.model');
  });
});
