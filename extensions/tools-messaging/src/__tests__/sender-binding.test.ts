// B-T4 (plan/phases/trust-before-reach.md) — `send_message` names its sender.
//
// `MessagingSendFn` has always declared a `botKey`; the tool never passed one,
// so every send resolved by platform and the first-registered adapter answered
// for whichever bot's turn produced it. The lane key is where the answer
// already lives: a channel turn runs on `${platform}:${botKey}:${chatId}`.

import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createMessagingTools, laneSenderBotKey } from '../index';

function ctx(partial: Partial<ToolContext>): ToolContext {
  return { personalityId: 'p', ...partial } as ToolContext;
}

function sendMessageTool(send = vi.fn(async () => ({ ok: true }))): {
  tool: Tool;
  send: ReturnType<typeof vi.fn>;
} {
  const tools = createMessagingTools({ send });
  const tool = tools.find((t) => t.name === 'send_message');
  if (!tool) throw new Error('send_message not registered');
  return { tool, send };
}

describe('laneSenderBotKey', () => {
  it('reads the botKey out of a channel lane key', () => {
    expect(
      laneSenderBotKey({ platform: 'telegram', sessionKey: 'telegram:support-bot:C9' }, 'telegram'),
    ).toBe('support-bot');
  });

  it('reads a thread lane the same way — the botKey is still segment 1', () => {
    expect(
      laneSenderBotKey(
        { platform: 'slack', sessionKey: 'slack:sales-bot:C1:1700000000.1' },
        'slack',
      ),
    ).toBe('sales-bot');
  });

  it('decodes a botKey that needed encoding', () => {
    expect(
      laneSenderBotKey({ platform: 'telegram', sessionKey: 'telegram:bot%3Aone:C9' }, 'telegram'),
    ).toBe('bot:one');
  });

  it('names no sender for a turn on a different platform', () => {
    expect(
      laneSenderBotKey({ platform: 'telegram', sessionKey: 'telegram:support-bot:C9' }, 'slack'),
    ).toBeUndefined();
  });

  it('names no sender for a web or CLI turn', () => {
    expect(laneSenderBotKey({ platform: 'web', sessionKey: 'web-session-123' }, 'telegram')).toBe(
      undefined,
    );
    expect(laneSenderBotKey({ platform: 'cli', sessionKey: 'cli:ethos' }, 'telegram')).toBe(
      undefined,
    );
  });

  it('names no sender when the context carries no session key', () => {
    expect(laneSenderBotKey({ platform: 'telegram' }, 'telegram')).toBeUndefined();
  });
});

describe('send_message — sender binding', () => {
  it('passes the lane’s botKey when the target is the lane’s own platform', async () => {
    const { tool, send } = sendMessageTool();

    const result = await tool.execute(
      { platform: 'telegram', target: 'C9', body: 'hi' },
      ctx({ platform: 'telegram', sessionKey: 'telegram:support-bot:C9' }),
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith('telegram', 'C9', 'hi', 'support-bot');
  });

  it('passes no botKey when the target is a different platform', async () => {
    const { tool, send } = sendMessageTool();

    await tool.execute(
      { platform: 'slack', target: 'C1', body: 'hi' },
      ctx({ platform: 'telegram', sessionKey: 'telegram:support-bot:C9' }),
    );

    expect(send).toHaveBeenCalledWith('slack', 'C1', 'hi', undefined);
  });

  it('surfaces the send path’s refusal verbatim instead of retrying unbound', async () => {
    const send = vi.fn(async () => ({
      ok: false,
      error: 'ambiguous sender: 2 telegram bots are configured',
    }));
    const { tool } = sendMessageTool(send);

    const result = await tool.execute(
      { platform: 'telegram', target: 'C9', body: 'hi' },
      ctx({ platform: 'web', sessionKey: 'web-session-123' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ambiguous sender');
  });
});
