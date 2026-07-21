import { channelConfigError, type EthosError, type PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  renderAdapterFailure,
  startAdaptersGuarded,
  wireAdapterFatalHandlers,
  wrapAdapterError,
} from '../gateway';

// Adapter failure isolation — one misconfigured channel must not kill the
// gateway. Mirrors the stub-adapter harness used by gateway-health.test.ts.

interface StubAdapterOpts {
  startError?: unknown;
  withFatalSeam?: boolean;
}

interface FatalCapableStub extends PlatformAdapter {
  fireFatal: (err: unknown) => void;
  stopped: () => boolean;
}

function stubAdapter(
  id: string,
  displayName: string,
  opts: StubAdapterOpts = {},
): FatalCapableStub {
  let fatalHandler: ((err: unknown) => void) | undefined;
  let stopped = false;
  const adapter = {
    id,
    displayName,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: async () => {
      if (opts.startError !== undefined) throw opts.startError;
    },
    stop: async () => {
      stopped = true;
    },
    send: async () => ({ ok: true }),
    onMessage: () => {},
    health: async () => ({ ok: true }),
    ...(opts.withFatalSeam
      ? {
          onFatalError: (handler: (err: unknown) => void) => {
            fatalHandler = handler;
          },
        }
      : {}),
    fireFatal: (err: unknown) => fatalHandler?.(err),
    stopped: () => stopped,
  };
  return adapter as unknown as FatalCapableStub;
}

describe('startAdaptersGuarded', () => {
  it('starts the remaining adapters when one start() rejects', async () => {
    const failing = stubAdapter('discord:bot', 'Discord', {
      startError: new Error('Used disallowed intents'),
    });
    const telegram = stubAdapter('telegram:bot-1', 'Telegram');
    const slack = stubAdapter('slack:app-1', 'Slack');
    const failures: Array<{ id: string; error: EthosError }> = [];

    const result = await startAdaptersGuarded([failing, telegram, slack], (adapter, error) => {
      failures.push({ id: adapter.id, error });
    });

    expect(result.started.map((a) => a.id).sort()).toEqual(['slack:app-1', 'telegram:bot-1']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.adapterId).toBe('discord:bot');
    expect(failures).toHaveLength(1);
    // Unclassified error gains the platform prefix.
    expect(failures[0]?.error.cause).toContain('Discord adapter failed:');
  });

  it('passes classified CHANNEL_CONFIG errors through untouched', async () => {
    const classified = channelConfigError(
      'Discord',
      'this bot does not have the Message Content privileged intent enabled.',
      "Enable 'Message Content Intent' in the Discord Developer Portal, then restart the gateway.",
    );
    const failing = stubAdapter('discord:bot', 'Discord', { startError: classified });
    const onFailure = vi.fn();

    const result = await startAdaptersGuarded([failing], onFailure);

    expect(result.failures[0]?.error).toBe(classified);
    expect(result.failures[0]?.error.code).toBe('CHANNEL_CONFIG');
  });

  it('reports every adapter failed without throwing (gateway continues)', async () => {
    const a = stubAdapter('discord:bot', 'Discord', { startError: new Error('a') });
    const b = stubAdapter('telegram:bot', 'Telegram', { startError: new Error('b') });

    const result = await startAdaptersGuarded([a, b], () => {});

    expect(result.started).toHaveLength(0);
    expect(result.failures).toHaveLength(2);
  });
});

describe('wireAdapterFatalHandlers', () => {
  it('routes a late async failure to onFatal with the platform-wrapped error', () => {
    const discord = stubAdapter('discord:bot', 'Discord', { withFatalSeam: true });
    const noSeam = stubAdapter('email', 'Email');
    const onFatal = vi.fn();

    wireAdapterFatalHandlers([discord, noSeam], onFatal);
    discord.fireFatal(new Error('Used disallowed intents'));

    expect(onFatal).toHaveBeenCalledTimes(1);
    const [adapter, error] = onFatal.mock.calls[0] ?? [];
    expect((adapter as PlatformAdapter).id).toBe('discord:bot');
    expect((error as EthosError).cause).toContain('Discord adapter failed:');
  });

  it('supports the disable flow: late failure marks the adapter disabled and stops it', () => {
    const discord = stubAdapter('discord:bot', 'Discord', { withFatalSeam: true });
    const telegram = stubAdapter('telegram:bot', 'Telegram', { withFatalSeam: true });
    const disabled = new Set<string>();
    const logs: string[] = [];
    // Mirrors runGatewayStart's idempotent disableAdapter closure.
    const disableAdapter = (adapter: PlatformAdapter, error: EthosError): void => {
      if (disabled.has(adapter.id)) return;
      disabled.add(adapter.id);
      logs.push(renderAdapterFailure(adapter.displayName, error));
      void adapter.stop().catch(() => {});
    };
    wireAdapterFatalHandlers([discord, telegram], disableAdapter);

    discord.fireFatal(
      channelConfigError('Discord', 'intent missing.', 'Enable it, then restart the gateway.'),
    );
    discord.fireFatal(new Error('again')); // second fatal is a no-op

    expect(disabled.has('discord:bot')).toBe(true);
    expect(disabled.has('telegram:bot')).toBe(false);
    expect(discord.stopped()).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Discord configuration problem (not an Ethos issue)');
    expect(logs[0]).toContain('Discord DISABLED for this run');
    expect(logs[0]).toContain('other channels continue');
  });
});

describe('wrapAdapterError', () => {
  it('prefixes unknown errors with the platform name and keeps INTERNAL', () => {
    const wrapped = wrapAdapterError('Discord', new Error('Used disallowed intents'));
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.cause).toBe('Discord adapter failed: Used disallowed intents');
  });

  it('passes EthosError through unchanged', () => {
    const original = channelConfigError('Telegram', 'bad token.', 'Regenerate at @BotFather.');
    expect(wrapAdapterError('Telegram', original)).toBe(original);
  });

  it('handles non-Error throwables', () => {
    const wrapped = wrapAdapterError('Slack', 'boom');
    expect(wrapped.cause).toBe('Slack adapter failed: boom');
  });
});
