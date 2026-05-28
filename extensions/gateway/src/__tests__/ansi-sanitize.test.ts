import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';

// Minimal fake loop that yields text_delta events containing ANSI escapes.
function makeFakeLoopWithAnsi(text: string): AgentLoop {
  const hooks = new DefaultHookRegistry();
  return {
    hooks,
    async *run() {
      yield { type: 'text_delta' as const, text };
      yield { type: 'done' as const, text, turnCount: 1 };
    },
  } as unknown as AgentLoop;
}

function makeFakeAdapter(id = 'telegram:bot-1'): PlatformAdapter & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    id,
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: true,
    canReact: true,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(_chatId: string, msg: { text: string }): Promise<DeliveryResult> {
      sentMessages.push(msg.text);
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sentMessages,
  };
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'C123',
    userId: 'U1',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Date.now()}`,
    raw: null,
    ...overrides,
  };
}

describe('Gateway ANSI escape sanitization', () => {
  it('strips ANSI color sequences from LLM response before sending to adapter', async () => {
    const ansiText = '\x1b[31mred text\x1b[0m and \x1b[32mgreen text\x1b[0m';
    const loop = makeFakeLoopWithAnsi(ansiText);
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    });

    await gateway.handleMessage(inbound('hello'), adapter);

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).toBe('red text and green text');
    expect(adapter.sentMessages[0]).not.toContain('\x1b');
  });

  it('strips cursor/screen control sequences from LLM response', async () => {
    const ansiText = '\x1b[2J\x1b[Hstart of screen';
    const loop = makeFakeLoopWithAnsi(ansiText);
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    });

    await gateway.handleMessage(inbound('hello'), adapter);

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).toBe('start of screen');
    expect(adapter.sentMessages[0]).not.toContain('\x1b');
  });

  it('strips OSC (title-set) sequences from LLM response', async () => {
    const ansiText = '\x1b]0;malicious title\x07visible content';
    const loop = makeFakeLoopWithAnsi(ansiText);
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    });

    await gateway.handleMessage(inbound('hello'), adapter);

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).toBe('visible content');
    expect(adapter.sentMessages[0]).not.toContain('\x1b');
  });

  it('strips ANSI from error response path too', async () => {
    const hooks = new DefaultHookRegistry();
    const loop = {
      hooks,
      async *run() {
        yield { type: 'text_delta' as const, text: '\x1b[31mpartial\x1b[0m' };
        yield { type: 'error' as const, error: 'something failed', code: 'internal' };
      },
    } as unknown as AgentLoop;
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    });

    await gateway.handleMessage(inbound('hello'), adapter);

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).not.toContain('\x1b');
    expect(adapter.sentMessages[0]).toContain('partial');
    expect(adapter.sentMessages[0]).toContain('something failed');
  });

  it('passes through clean text unchanged', async () => {
    const cleanText = 'Hello, world! This is a **markdown** response.';
    const loop = makeFakeLoopWithAnsi(cleanText);
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    });

    await gateway.handleMessage(inbound('hello'), adapter);

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).toBe(cleanText);
  });
});
