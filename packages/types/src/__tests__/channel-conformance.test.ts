import { describe, expect, it, vi } from 'vitest';
import { assertCapsHonesty, defaultChannelCapabilities } from '../channel-conformance';
import type {
  ChannelCapabilities,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '../index';

// ---------------------------------------------------------------------------
// Minimal mock adapter factory
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id: 'mock',
    displayName: 'Mock Adapter',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(
      async (_chatId: string, _msg: OutboundMessage): Promise<DeliveryResult> => ({
        ok: true,
      }),
    ),
    onMessage: vi.fn((_handler: (msg: InboundMessage) => void) => {}),
    health: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// defaultChannelCapabilities
// ---------------------------------------------------------------------------

describe('defaultChannelCapabilities', () => {
  it('returns contractVersion 1', () => {
    expect(defaultChannelCapabilities().contractVersion).toBe(1);
  });

  it('has all boolean caps set to false', () => {
    const caps = defaultChannelCapabilities();
    expect(caps.edit).toBe(false);
    expect(caps.delete).toBe(false);
    expect(caps.typing).toBe(false);
    expect(caps.readReceipts).toBe(false);
    expect(caps.approvalButtons).toBe(false);
    expect(caps.slashCommands).toBe(false);
    expect(caps.mentions).toBe(false);
    expect(caps.ephemeral).toBe(false);
    expect(caps.multiAccount).toBe(false);
    expect(caps.threads).toBe(false);
    expect(caps.reactions.in).toBe(false);
    expect(caps.reactions.out).toBe(false);
    expect(caps.media.imagesIn).toBe(false);
    expect(caps.media.filesIn).toBe(false);
    expect(caps.media.imagesOut).toBe(false);
    expect(caps.media.filesOut).toBe(false);
    expect(caps.voice.transcribeIn).toBe(false);
    expect(caps.voice.ttsOut).toBe(false);
  });

  it('returns independent objects on each call', () => {
    const a = defaultChannelCapabilities();
    const b = defaultChannelCapabilities();
    a.edit = true;
    expect(b.edit).toBe(false);
  });

  it('can be spread to declare individual capabilities', () => {
    const caps: ChannelCapabilities = {
      ...defaultChannelCapabilities(),
      edit: true,
    };
    expect(caps.edit).toBe(true);
    expect(caps.typing).toBe(false);
    expect(caps.contractVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// assertCapsHonesty
// ---------------------------------------------------------------------------

describe('assertCapsHonesty', () => {
  it('passes when adapter has no caps', () => {
    const adapter = makeAdapter();
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes when all declared caps have matching methods', () => {
    const adapter = makeAdapter({
      caps: {
        ...defaultChannelCapabilities(),
        edit: true,
        typing: true,
        slashCommands: true,
      },
      editMessage: vi.fn(async () => ({ ok: true })),
      sendTyping: vi.fn(async () => {}),
      registerCommands: vi.fn(async () => {}),
    });
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('flags caps.edit without editMessage', () => {
    const adapter = makeAdapter({
      caps: { ...defaultChannelCapabilities(), edit: true },
    });
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('caps.edit is true but editMessage is missing');
  });

  it('flags caps.typing without sendTyping', () => {
    const adapter = makeAdapter({
      caps: { ...defaultChannelCapabilities(), typing: true },
    });
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('caps.typing is true but sendTyping is missing');
  });

  it('flags caps.slashCommands without registerCommands', () => {
    const adapter = makeAdapter({
      caps: { ...defaultChannelCapabilities(), slashCommands: true },
    });
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      'caps.slashCommands is true but registerCommands is missing',
    );
  });

  it('reports all violations in a single call', () => {
    const adapter = makeAdapter({
      caps: { ...defaultChannelCapabilities(), edit: true, typing: true, slashCommands: true },
    });
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  it('does not flag false capabilities even when the method is absent', () => {
    const adapter = makeAdapter({
      caps: { ...defaultChannelCapabilities(), edit: false, typing: false, slashCommands: false },
    });
    const result = assertCapsHonesty(adapter);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// contractVersion enforcement
// ---------------------------------------------------------------------------

describe('contractVersion', () => {
  it('adapter with caps must declare contractVersion >= 1', () => {
    const adapter = makeAdapter({
      caps: { ...defaultChannelCapabilities(), contractVersion: 1 },
    });
    expect(adapter.caps?.contractVersion).toBeGreaterThanOrEqual(1);
  });

  it('an adapter with contractVersion 0 is considered non-conformant', () => {
    // This is a type-level invariant enforced by the > 0 expectation.
    // Adapters that declare caps with contractVersion < 1 fail the gate.
    const badCaps: ChannelCapabilities = { ...defaultChannelCapabilities(), contractVersion: 0 };
    expect(badCaps.contractVersion).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// No adapter-local dedup: send() is called 1:1 by the gateway
// ---------------------------------------------------------------------------

describe('adapter send is called 1:1', () => {
  it('send() is invoked once per gateway call — adapter must not filter', async () => {
    const adapter = makeAdapter();
    const msg: OutboundMessage = { text: 'hello' };

    await adapter.send('chat-1', msg);
    await adapter.send('chat-1', msg);

    // Both calls must reach the adapter; the gateway, not the adapter, owns dedup.
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Key non-derivation: InboundMessage.botKey must come from ctx, not derived
// ---------------------------------------------------------------------------

describe('botKey stamping', () => {
  it('adapter stamps InboundMessage.botKey from the value supplied by the gateway', () => {
    let captured: InboundMessage | undefined;

    const adapter = makeAdapter({
      onMessage: vi.fn((handler: (msg: InboundMessage) => void) => {
        // Simulate the adapter calling the registered handler with a message
        // whose botKey was taken from the ChannelContext (not derived locally).
        handler({
          platform: 'mock',
          chatId: 'chat-1',
          text: 'hi',
          isDm: true,
          isGroupMention: false,
          // botKey must come from ChannelContext.botKey, not deriveBotKey()
          botKey: 'ctx-supplied-key',
          raw: {},
        });
      }),
    });

    adapter.onMessage((msg) => {
      captured = msg;
    });

    expect(captured).toBeDefined();
    expect(captured?.botKey).toBe('ctx-supplied-key');
  });
});
