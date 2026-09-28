// plan personality-memory-boundary D9 / step 3 — `gateway.private_chats` reaches
// `GatewayConfig.privateChats` in both production hosts.
//
// Both `ethos gateway start` and `ethos boot` build their Gateway through
// `buildGateway(opts)` with the loaded config, so the conversion lives in one
// place. Pinned here:
//  - `buildGateway` hands the Gateway a `PrivateChatSet` built from
//    `config.gateway.privateChats`, on the idle (no bot) branch and the
//    multi-bot branch alike, and hands it nothing when the key is absent
//    (runtime, by capturing the constructor's argument);
//  - both hosts call `buildGateway` with the config they loaded (source text —
//    `runGatewayStart` and `runBoot` boot whole processes and cannot be invoked
//    from a unit test; see `gateway-observability-wiring.test.ts`).
// The Gateway does not READ the set until plan step 4.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { GatewayConfig } from '@ethosagent/gateway';
import type { PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BuildGatewayOptions, buildGateway } from '../commands/gateway';

const captured = vi.hoisted(() => [] as GatewayConfig[]);

vi.mock('@ethosagent/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/gateway')>();
  class CapturingGateway extends actual.Gateway {
    constructor(config: GatewayConfig) {
      captured.push(config);
      super(config);
    }
  }
  return { ...actual, Gateway: CapturingGateway };
});

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

function build(config: EthosConfig, botKeys: string[]) {
  return buildGateway({
    config,
    bots: botKeys.map((botKey) => ({
      botKey,
      loop: stubLoop(),
      binding: { type: 'personality' as const, name: 'default' },
    })),
    systemLoop: stubLoop(),
    adapters: botKeys.map((k) => stubAdapter(`telegram:${k}`)),
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
    observability: {
      recordSafetyBlock: () => {},
      recordChannelAllow: () => {},
      recordChannelDeny: () => {},
    },
  });
}

const WITH_LIST: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-a',
  apiKey: '',
  personality: 'default',
  gateway: { privateChats: { telegram: ['-1001'], slack: ['C0TEAM'] } },
};

afterEach(() => {
  captured.length = 0;
});

describe('buildGateway — GatewayConfig.privateChats', () => {
  it.each([
    ['multi-bot', ['sales-bot', 'support-bot']],
    ['idle (no bot)', []],
  ])('%s branch: a listed room is in the set, nothing else is', async (_label, botKeys) => {
    const gw = build(WITH_LIST, botKeys);
    const set = captured[0]?.privateChats;
    expect(set).toBeDefined();
    expect(set?.has('telegram', '-1001')).toBe(true);
    expect(set?.has('slack', 'C0TEAM')).toBe(true);
    expect(set?.has('telegram', '-1002')).toBe(false);
    expect(set?.has('discord', '-1001')).toBe(false);
    await gw.shutdown();
  });

  it('passes no set when the key is absent', async () => {
    const gw = build({ personality: 'default' } as EthosConfig, ['sales-bot']);
    expect(captured[0]).toBeDefined();
    expect(captured[0]?.privateChats).toBeUndefined();
    await gw.shutdown();
  });

  it('does not create a channel filter as a side effect', async () => {
    const gw = build(WITH_LIST, ['sales-bot']);
    expect(captured[0]?.channelFilter).toBeUndefined();
    await gw.shutdown();
  });
});

describe('production hosts build the gateway from the loaded config', () => {
  it.each([
    ['ethos gateway start', 'apps/ethos/src/commands/gateway.ts', /buildGateway\(\{\s*config,/],
    ['ethos boot', 'apps/ethos/src/commands/boot.ts', /buildGateway\(\{\s*config: cfg,/],
  ])('%s', async (_host, file, pattern) => {
    expect(await read(file)).toMatch(pattern);
  });
});
