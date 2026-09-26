// Gateway observability in production (reach-and-containment follow-up).
//
// The Gateway records every `gateway.*` event — safety blocks, channel
// allow/deny, the inbound spool's `gateway.spool_*` — through
// `this.observability?.…`. Both production hosts (`ethos gateway start` and
// `ethos boot`) built it through `buildGateway` without one, so every one of
// those events was recorded nowhere and nothing failed to say so.
//
// Three things are pinned here:
//  - `buildGateway` forwards `observability` to the Gateway (runtime);
//  - `gatewayObservability()` resolves the sink per call and is fail-open
//    (runtime);
//  - both production call sites pass `gatewayObservability()` (source text —
//    `runGatewayStart` and `runBoot` boot whole processes and cannot be invoked
//    from a unit test; see `gateway-platform-webhook-wiring.test.ts` for the
//    same idiom and why).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { GatewayObservability } from '@ethosagent/gateway';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type BuildGatewayOptions, buildGateway, gatewayObservability } from '../commands/gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

function stubLoop(): AgentLoop {
  return {
    run: vi.fn(async function* () {}),
    hooks: { registerVoid: vi.fn(() => () => {}) },
  } as unknown as AgentLoop;
}

function stubAdapter(id: string): PlatformAdapter {
  return {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
}

function recordingSink() {
  const blocks: string[] = [];
  const sink: GatewayObservability = {
    recordSafetyBlock: (o) => {
      blocks.push(o.code ?? '');
    },
    recordChannelAllow: () => {},
    recordChannelDeny: () => {},
  };
  return { sink, blocks };
}

function gatewayWith(observability: BuildGatewayOptions['observability']) {
  return buildGateway({
    config: { personality: 'default' } as EthosConfig,
    bots: ['sales-bot', 'support-bot'].map((botKey) => ({
      botKey,
      loop: stubLoop(),
      binding: { type: 'personality' as const, name: 'default' },
    })),
    systemLoop: stubLoop(),
    adapters: [stubAdapter('telegram:sales-bot'), stubAdapter('telegram:support-bot')],
    deliveryLedger: undefined,
    inboundDedup: undefined,
    resolveUserId: undefined,
    pluginLoader: {
      getPlatformAdapters: () => new Map(),
      getSlashHandler: () => undefined,
      getAllSlashCommands: () => [],
    } as unknown as BuildGatewayOptions['pluginLoader'],
    trustedChannelPlugins: undefined,
    notificationRouter: {
      route: async () => {},
      register: () => {},
      deregister: () => {},
    } as unknown as BuildGatewayOptions['notificationRouter'],
    storage: undefined,
    attachmentCache: {
      clear: async () => {},
    } as unknown as BuildGatewayOptions['attachmentCache'],
    sttProviders: undefined,
    ttsProviders: undefined,
    voiceConfig: {} as BuildGatewayOptions['voiceConfig'],
    voiceModeStore: undefined,
    voiceArtifacts: undefined,
    transcoder: undefined,
    channelVoiceOut: undefined,
    voiceBitrateKbps: undefined,
    personalityDirectory: undefined,
    onTurnComplete: undefined,
    onUserTurn: undefined,
    streamingEdits: undefined,
    pairingDb: undefined,
    channelTranscript: undefined,
    clarifyMessageCorrelator: undefined,
    personalityCardReader: undefined,
    greetingProvider: undefined,
    publicationSpeaksFor: () => true,
    observability,
  });
}

/** A message stamped with a botKey no configured bot owns. In a multi-bot
 *  gateway there is no fallback, so it is dropped with a `gateway.*` event. */
const strayMessage: InboundMessage = {
  platform: 'telegram',
  chatId: 'C1',
  text: 'hello',
  isDm: true,
  isGroupMention: false,
  botKey: 'ghost-bot',
  messageId: 'm1',
  raw: {},
};

describe('buildGateway — observability reaches the Gateway', () => {
  it('a dropped message is recorded through the sink the host passed', async () => {
    const { sink, blocks } = recordingSink();
    const gw = gatewayWith(sink);

    await gw.handleMessage(strayMessage, stubAdapter('telegram:sales-bot'));

    expect(blocks).toContain('gateway.no_bot_available');
    await gw.shutdown();
  });
});

describe('gatewayObservability — the production sink', () => {
  it('resolves the process sink on every call, so a reopened store is picked up', () => {
    const first = recordingSink();
    const second = recordingSink();
    const get = vi.fn().mockReturnValueOnce(first.sink).mockReturnValueOnce(second.sink);
    const sink = gatewayObservability(get);

    sink.recordSafetyBlock({ code: 'gateway.a' });
    sink.recordSafetyBlock({ code: 'gateway.b' });

    expect(get).toHaveBeenCalledTimes(2);
    expect(first.blocks).toEqual(['gateway.a']);
    expect(second.blocks).toEqual(['gateway.b']);
  });

  it('forwards channel.pairing rows to the process sink', () => {
    const recordChannelPairing = vi.fn();
    const sink = gatewayObservability(() => ({
      recordSafetyBlock: () => {},
      recordChannelAllow: () => {},
      recordChannelDeny: () => {},
      recordChannelPairing,
    }));

    sink.recordChannelPairing?.({ code: 'channel.pairing.issued' });

    expect(recordChannelPairing).toHaveBeenCalledWith({ code: 'channel.pairing.issued' });
  });

  it('is fail-open: a store that will not open, or a record that throws, never reaches the Gateway', async () => {
    const unopenable = gatewayObservability(() => {
      throw new Error('observability.db: disk I/O error');
    });
    expect(() => unopenable.recordSafetyBlock({ code: 'gateway.x' })).not.toThrow();
    expect(() => unopenable.recordChannelDeny({ code: 'gateway.x' })).not.toThrow();

    const throwing = gatewayObservability(() => ({
      recordSafetyBlock: () => {
        throw new Error('SQLITE_BUSY');
      },
      recordChannelAllow: () => {},
      recordChannelDeny: () => {},
    }));
    expect(() => throwing.recordSafetyBlock({ code: 'gateway.x' })).not.toThrow();
    // A sink without the optional method is not an error either.
    expect(() => throwing.recordInjectionFlag?.({ code: 'gateway.x' })).not.toThrow();

    // And the Gateway keeps handling messages with it wired in.
    const gw = gatewayWith(unopenable);
    await expect(
      gw.handleMessage(strayMessage, stubAdapter('telegram:sales-bot')),
    ).resolves.toBeUndefined();
    await gw.shutdown();
  });
});

describe('production hosts pass the sink', () => {
  it.each([
    ['ethos gateway start', 'apps/ethos/src/commands/gateway.ts'],
    ['ethos boot', 'apps/ethos/src/commands/boot.ts'],
  ])('%s builds its Gateway with gatewayObservability()', async (_name, file) => {
    const src = await read(file);
    const call = src.slice(src.indexOf('buildGateway({'));
    const body = call.slice(0, call.indexOf('\n  });'));
    expect(body).toMatch(/\n\s+observability: gatewayObservability\(\),/);
  });
});
