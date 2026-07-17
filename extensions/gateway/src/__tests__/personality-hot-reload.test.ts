import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';

// Fake loop that records the personalityId each turn resolved to.
function makeFakeLoop(): AgentLoop & { runArgs: Array<string | undefined> } {
  const hooks = new DefaultHookRegistry();
  const runArgs: Array<string | undefined> = [];
  const loop = {
    hooks,
    async *run(_text: string, opts?: { personalityId?: string }) {
      runArgs.push(opts?.personalityId);
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
    runArgs,
  } as unknown as AgentLoop & { runArgs: Array<string | undefined> };
  return loop;
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
    messageId: `msg-${Date.now()}-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

function makeGateway(
  loop: AgentLoop,
  personalityDirectory?: GatewayConfig['personalityDirectory'],
): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop,
        binding: { type: 'personality', name: 'researcher', allowSlashSwitch: true },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...(personalityDirectory ? { personalityDirectory } : {}),
  });
}

describe('gateway /personality — validate-on-switch (criterion 4)', () => {
  it('rejects an unknown id: replies not-found, does not store the id, next turn runs the previous personality', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const gateway = makeGateway(loop, {
      refresh,
      has: (id) => id === 'researcher',
      list: () => [{ id: 'researcher', name: 'Researcher', isDefault: true }],
    });

    await gateway.handleMessage(inbound('/personality nope'), adapter);

    expect(refresh).toHaveBeenCalled();
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).toBe(
      "Personality 'nope' not found — /personality list to see what's available.",
    );

    // personalityIds unchanged → `/personality` (no arg) still reports the binding.
    await gateway.handleMessage(inbound('/personality'), adapter);
    expect(adapter.sentMessages[1]).toBe('Current personality: researcher');

    // Next real turn still resolves the previous personality, not 'nope'.
    await gateway.handleMessage(inbound('hello'), adapter);
    expect(loop.runArgs.at(-1)).toBe('researcher');
  });

  it('stores a valid id when the seam confirms it', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, {
      refresh: async () => {},
      has: (id) => id === 'researcher' || id === 'engineer',
      list: () => [],
    });

    await gateway.handleMessage(inbound('/personality engineer'), adapter);
    expect(adapter.sentMessages[0]).toContain('Switched to engineer');

    await gateway.handleMessage(inbound('hello'), adapter);
    expect(loop.runArgs.at(-1)).toBe('engineer');
  });
});

describe('gateway /personality — validate-on-switch without the seam (review fix)', () => {
  function makeLoopWithIds(ids: string[]): AgentLoop & { runArgs: Array<string | undefined> } {
    const loop = makeFakeLoop();
    (loop as unknown as { getPersonalityIds: () => string[] }).getPersonalityIds = () => ids;
    return loop;
  }

  it('rejects an unknown id via the loop registry when no seam is wired (stores nothing)', async () => {
    const loop = makeLoopWithIds(['researcher', 'engineer']);
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop); // no personalityDirectory seam

    await gateway.handleMessage(inbound('/personality nope'), adapter);
    expect(adapter.sentMessages[0]).toBe(
      "Personality 'nope' not found — /personality list to see what's available.",
    );

    // Unverified id was NOT stored — the next turn still runs the binding.
    await gateway.handleMessage(inbound('hello'), adapter);
    expect(loop.runArgs.at(-1)).toBe('researcher');
  });

  it('accepts a known id via the loop registry when no seam is wired', async () => {
    const loop = makeLoopWithIds(['researcher', 'engineer']);
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop);

    await gateway.handleMessage(inbound('/personality engineer'), adapter);
    expect(adapter.sentMessages[0]).toContain('Switched to engineer');

    await gateway.handleMessage(inbound('hello'), adapter);
    expect(loop.runArgs.at(-1)).toBe('engineer');
  });
});

describe('gateway personality refresh — fail-open (review fix)', () => {
  it('a refresh that rejects does not abort the turn; the loop still runs', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, {
      refresh: async () => {
        throw new Error('malformed personality YAML on disk');
      },
      has: () => true,
      list: () => [],
    });

    await gateway.handleMessage(inbound('hello'), adapter);

    // Despite refresh throwing, the turn resolved and ran with the binding.
    expect(loop.runArgs.at(-1)).toBe('researcher');
  });
});

describe('gateway /personality list — real registry render (criterion 5)', () => {
  it('renders personalityDirectory.list(); the hardcoded builtins string is gone', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, {
      refresh: async () => {},
      has: () => true,
      list: () => [
        { id: 'researcher', name: 'Researcher', isDefault: true },
        { id: 'moonwriter', name: 'Moon Writer', isDefault: false },
      ],
    });

    await gateway.handleMessage(inbound('/personality list'), adapter);
    expect(adapter.sentMessages).toHaveLength(1);
    const text = adapter.sentMessages[0] ?? '';
    expect(text).toContain('moonwriter — Moon Writer');
    expect(text).toContain('researcher — Researcher (default)');
    expect(text).not.toContain('Built-in personalities: researcher · engineer');
  });

  it('falls back to the legacy hardcoded string when the seam is absent', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop);

    await gateway.handleMessage(inbound('/personality list'), adapter);
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]).toContain('Built-in personalities: researcher · engineer');
  });
});
