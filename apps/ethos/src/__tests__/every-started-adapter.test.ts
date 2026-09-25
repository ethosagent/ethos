// Plugin-registered platform adapters were never stopped on shutdown. The
// Gateway constructs AND starts them itself (`GatewayConfig.pluginAdapters`),
// so they were in no host's `adapters` list, and both hosts stopped only that
// list. `everyStartedAdapter` is the one list both shutdowns now stop.
//
// Runtime: through the real `buildGateway` both hosts call, a plugin adapter is
// started, lands in the stop list exactly once, and a hung plugin `stop()` is
// left behind at the step bound. Source text: both hosts stop that list in
// their bounded adapters step (`runGatewayStart`/`runBoot` boot whole processes
// and cannot be invoked from a unit test — the idiom and reason of
// `gateway-observability-wiring.test.ts`).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { ChannelContext, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type BuildGatewayOptions, buildGateway, everyStartedAdapter } from '../commands/gateway';
import { boundedShutdownStep } from '../lib/bounded-shutdown-step';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

function stubLoop(): AgentLoop {
  return {
    run: vi.fn(async function* () {}),
    hooks: { registerVoid: vi.fn(() => () => {}) },
  } as unknown as AgentLoop;
}

function stubAdapter(id: string, stop: () => Promise<void> = async () => {}): PlatformAdapter {
  return {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(stop),
    send: vi.fn().mockResolvedValue({ ok: true }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
}

/** A gateway built the way both hosts build it, with one built-in adapter and
 *  one plugin-registered adapter (`fakechan/chan`, the smoke plugin's name). */
function gatewayWithPlugin(pluginStop: () => Promise<void>) {
  const builtIn = stubAdapter('telegram:sales-bot');
  const plugin = stubAdapter('fakechan/chan', pluginStop);
  let pluginCtx: ChannelContext | undefined;
  (plugin as { startWithContext?: (ctx: ChannelContext) => Promise<void> }).startWithContext =
    vi.fn(async (ctx: ChannelContext) => {
      pluginCtx = ctx;
    });
  const gateway = buildGateway({
    config: { personality: 'default' } as EthosConfig,
    bots: [
      {
        botKey: 'sales-bot',
        loop: stubLoop(),
        binding: { type: 'personality' as const, name: 'default' },
      },
    ],
    systemLoop: stubLoop(),
    adapters: [builtIn],
    deliveryLedger: undefined,
    inboundDedup: undefined,
    resolveUserId: undefined,
    pluginLoader: {
      getPlatformAdapters: () => new Map([['fakechan/chan', () => plugin]]),
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
  return { gateway, builtIn, plugin, started: () => pluginCtx !== undefined };
}

describe('everyStartedAdapter — what a host shutdown stops', () => {
  it('includes the plugin-registered adapter the Gateway started, and each adapter once', () => {
    const { gateway, builtIn, plugin, started } = gatewayWithPlugin(async () => {});
    expect(started()).toBe(true);
    const list = everyStartedAdapter([builtIn], gateway);
    expect(list).toContain(plugin);
    expect(list).toContain(builtIn);
    // `builtIn` is in the host list AND in the Gateway's live list.
    expect(list.filter((a) => a === builtIn)).toHaveLength(1);
    expect(list).toHaveLength(2);
  });

  it('the shutdown step stops the plugin adapter; a hung plugin stop() is left at the bound', async () => {
    const { gateway, builtIn, plugin } = gatewayWithPlugin(() => new Promise<void>(() => {}));
    const blocks: Array<{ code?: string; details?: Record<string, unknown> }> = [];
    const t0 = Date.now();
    await boundedShutdownStep(
      'adapters stop',
      () => Promise.allSettled(everyStartedAdapter([builtIn], gateway).map((a) => a.stop())),
      { sink: () => ({ recordSafetyBlock: (o) => void blocks.push(o) }), warn: () => {} },
      100,
    );
    const elapsed = Date.now() - t0;
    expect(plugin.stop).toHaveBeenCalledTimes(1);
    expect(builtIn.stop).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1_000);
    expect(blocks).toEqual([
      {
        code: 'shutdown.step_timeout',
        cause: 'did not finish within 100ms — left behind',
        details: { step: 'adapters stop', timeoutMs: 100 },
      },
    ]);
  });

  // A reload that retires a built-in bot stops its adapter in
  // `Gateway.removeAdapter`, but the adapter stays in the host's own list
  // (boot's `adapters`). Shutdown must not stop it again.
  it('a built-in adapter a reload retired is stopped exactly once in total', async () => {
    const { gateway, builtIn, plugin } = gatewayWithPlugin(async () => {});
    await gateway.removeAdapter('sales-bot');
    expect(builtIn.stop).toHaveBeenCalledTimes(1);
    expect(gateway.hasStopped(builtIn)).toBe(true);

    const list = everyStartedAdapter([builtIn], gateway);
    expect(list).not.toContain(builtIn);
    expect(list).toContain(plugin);
    await Promise.allSettled(list.map((a) => a.stop()));
    expect(builtIn.stop).toHaveBeenCalledTimes(1);
    expect(plugin.stop).toHaveBeenCalledTimes(1);
  });

  it('boot reports health from the live adapter list, not the boot-time snapshot', async () => {
    const boot = await read('apps/ethos/src/commands/boot.ts');
    expect(boot).not.toContain('buildGatewayHeartbeat(adapters,');
    expect(boot.match(/buildGatewayHeartbeat\(gateway\.listAdapters\(\),/g)).toHaveLength(2);
  });

  it('both hosts stop everyStartedAdapter(adapters, gateway) in their bounded adapters step', async () => {
    const gw = await read('apps/ethos/src/commands/gateway.ts');
    expect(gw).toMatch(
      /boundedShutdownStep\(\s*'adapters stop',\s*\(\) => Promise\.allSettled\(everyStartedAdapter\(adapters, gateway\)\.map\(\(a\) => a\.stop\(\)\)\),/,
    );
    const boot = await read('apps/ethos/src/commands/boot.ts');
    expect(boot).toMatch(
      /await step\('adapters', \(\) =>\s*Promise\.allSettled\(everyStartedAdapter\(adapters, gateway\)\.map\(\(a\) => a\.stop\(\)\)\),/,
    );
    // Neither host still stops only its own built-in list.
    expect(gw).not.toContain('Promise.allSettled(adapters.map((a) => a.stop()))');
    expect(boot).not.toContain('Promise.allSettled(adapters.map((a) => a.stop()))');
  });
});
