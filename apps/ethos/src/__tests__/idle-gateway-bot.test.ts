// The idle gateway bot — no platform bot configured, turns arriving through a
// plugin adapter (the l2 smoke's `fakechan/chan`). It used to be built from
// the Gateway's legacy `loop` shorthand, with no job store and no background
// executor, and its loop recorded no origin bot, so a
// `delegate_task(background: true)` started on it finished with nobody to
// announce it. Both hosts now give it the system loop's job store + executor
// (`idleGatewayBot`) and stamp `originBotKey: 'default'` on that loop
// (`idleGatewayBotLoopOpts`).
//
// Runtime: through the real `buildGateway`, a completion on the idle bot's
// executor is announced in the plugin channel through the tracked path, and
// the restart sweep finds an unannounced one. Source text: both hosts pass the
// loop opts only when no bot is configured (`runGatewayStart`/`runBoot` boot
// whole processes — the idiom and reason of `every-started-adapter.test.ts`).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { BackgroundExecutor } from '@ethosagent/job-runner';
import type {
  BackgroundJob,
  ChannelContext,
  JobStore,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type BuildGatewayOptions,
  buildGateway,
  IDLE_GATEWAY_BOT_KEY,
  idleGatewayBotLoopOpts,
} from '../commands/gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

function stubLoop(): AgentLoop {
  return {
    run: vi.fn(async function* () {}),
    hooks: { registerVoid: vi.fn(() => () => {}) },
  } as unknown as AgentLoop;
}

function fakeExecutor() {
  const handlers: Array<(job: BackgroundJob) => void> = [];
  const executor = {
    onComplete: vi.fn((h: (job: BackgroundJob) => void) => {
      handlers.push(h);
      return () => {};
    }),
  } as unknown as BackgroundExecutor;
  const fire = (job: BackgroundJob): void => {
    for (const h of handlers) h(job);
  };
  return { executor, fire };
}

function fakeJobStore(jobs: BackgroundJob[]) {
  const claimed = new Set<string>();
  const store = {
    claimDelivery: vi.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
    releaseDelivery: vi.fn(async (id: string) => void claimed.delete(id)),
    listUndelivered: vi.fn(async (keys: string[]) =>
      jobs.filter((j) => j.originBotKey && keys.includes(j.originBotKey) && !claimed.has(j.id)),
    ),
  } as unknown as JobStore;
  return { store, claimed };
}

function job(id: string): BackgroundJob {
  return {
    id,
    status: 'done',
    summary: 'child result: 42',
    label: 'task',
    originPlatform: 'fakechan/chan',
    originBotKey: IDLE_GATEWAY_BOT_KEY,
    originChatId: 'chat-bg',
  } as BackgroundJob;
}

/** An idle gateway — no bots — with the smoke plugin's adapter. */
function idleGateway(jobs: BuildGatewayOptions['idleBotJobs']) {
  const sends: Array<{ chatId: string; text: string }> = [];
  const plugin = {
    id: 'fakechan/chan',
    displayName: 'Fake channel',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 100_000,
    startWithContext: vi.fn(async (_ctx: ChannelContext) => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async (chatId: string, m: OutboundMessage) => {
      sends.push({ chatId, text: m.text });
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn(async () => ({ ok: true })),
  } as unknown as PlatformAdapter;
  const gateway = buildGateway({
    config: { personality: 'smoker' } as EthosConfig,
    bots: [],
    systemLoop: stubLoop(),
    ...(jobs ? { idleBotJobs: jobs } : {}),
    adapters: [],
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
    attachmentCache: { clear: async () => {} } as unknown as BuildGatewayOptions['attachmentCache'],
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
  return { gateway, sends };
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('the idle gateway bot', () => {
  it('is the default-personality bot, with the system loop job store and executor', () => {
    const { executor } = fakeExecutor();
    const { store } = fakeJobStore([]);
    const { gateway } = idleGateway({ jobStore: store, backgroundExecutor: executor });
    const [bot, ...rest] = gateway.listBots();
    expect(rest).toEqual([]);
    expect(bot?.botKey).toBe(IDLE_GATEWAY_BOT_KEY);
    expect(bot?.binding).toEqual({ type: 'personality', name: 'smoker', allowSlashSwitch: true });
    expect(bot?.jobStore).toBe(store);
    expect(bot?.backgroundExecutor).toBe(executor);
    expect(executor.onComplete).toHaveBeenCalledTimes(1);
  });

  it('announces a finished background job in the plugin channel, claimed once', async () => {
    const { executor, fire } = fakeExecutor();
    const { store } = fakeJobStore([]);
    const { sends } = idleGateway({ jobStore: store, backgroundExecutor: executor });
    fire(job('job-1'));
    await waitUntil(() => sends.length > 0);
    expect(sends[0]?.chatId).toBe('chat-bg');
    expect(sends[0]?.text).toContain('finished — status: done');
    expect(sends[0]?.text).toContain('child result: 42');
    expect(store.claimDelivery).toHaveBeenCalledWith('job-1');
  });

  it('the restart sweep delivers one this process never heard finish', async () => {
    const { store } = fakeJobStore([job('job-2')]);
    const { gateway, sends } = idleGateway({ jobStore: store });
    expect(await gateway.sweepUndeliveredJobs()).toEqual({ delivered: 1, failed: 0 });
    expect(store.listUndelivered).toHaveBeenCalledWith([IDLE_GATEWAY_BOT_KEY]);
    expect(sends.map((s) => s.chatId)).toEqual(['chat-bg']);
  });

  it('stamps the idle bot key as the loop origin bot', () => {
    const resolve = (key: string) => `t:${key}`;
    const opts = idleGatewayBotLoopOpts(resolve);
    expect(opts.originBotKey).toBe(IDLE_GATEWAY_BOT_KEY);
    expect(opts.resolveOriginThreadId).toBe(resolve);
  });

  it('both hosts make the system loop the idle bot only when no bot is configured', async () => {
    const gw = await read('apps/ethos/src/commands/gateway.ts');
    const boot = await read('apps/ethos/src/commands/boot.ts');
    for (const src of [gw, boot]) {
      expect(src).toMatch(
        /\.\.\.\(bots\.length === 0\s*\?\s*idleGatewayBotLoopOpts\(\(sessionKey\) => gatewayRef\?\.originThreadIdFor\(sessionKey\)\)\s*: \{\}\),/,
      );
      expect(src).toMatch(/idleBotJobs: \{ jobStore: \w+(\.jobStore)?, backgroundExecutor: /);
    }
    // boot builds its bots before the system loop, so the count is known there.
    expect(boot.indexOf('const coldBuilt = await buildGatewayBots(')).toBeLessThan(
      boot.indexOf('const shared = await createAgentLoop(cfg, {'),
    );
  });
});
