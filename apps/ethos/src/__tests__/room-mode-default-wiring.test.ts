// Plan channel-prompts L12: the room config's default reply mode reaches each
// adapter as `roomModeDefault` (built in `buildAdapters` from the room table),
// and `loadRoomPolicies` validates a room `mode` against that adapter's own enum.

import type { ChannelsPlatformConfig, EthosConfig, RawRoomEntry } from '@ethosagent/config';
import { buildRoomPolicyTable, type RoomPolicyTable } from '@ethosagent/gateway';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import { type AdapterModuleLoader, buildAdapters, loadRoomPolicies } from '../commands/gateway';

const entries = (e: Record<string, RawRoomEntry>): ChannelsPlatformConfig['entries'] =>
  Object.assign(Object.create(null), e);

// Neither adapter is a dependency of this app (production inlines them via the
// bundler), so the bare specifier does not resolve under vitest. Point it at the
// REAL source so the enums validated against are the adapters' own.
vi.mock(
  '@ethosagent/platform-slack',
  () => import('../../../../extensions/platform-slack/src/index'),
);
vi.mock(
  '@ethosagent/platform-telegram',
  () => import('../../../../extensions/platform-telegram/src/index'),
);
vi.mock(
  '@ethosagent/platform-whatsapp',
  () => import('../../../../extensions/platform-whatsapp/src/index'),
);

describe('buildAdapters passes roomModeDefault (L12)', () => {
  const captured: Array<{ platform: string; cfg: Record<string, unknown> }> = [];
  const stub = (platform: string) =>
    class {
      id = platform;
      constructor(cfg: Record<string, unknown>) {
        captured.push({ platform, cfg });
      }
    };
  const loader: AdapterModuleLoader = async <T>(modulePath: string): Promise<T | null> => {
    const mods: Record<string, unknown> = {
      '@ethosagent/platform-slack': { SlackAdapter: stub('slack') },
      '@ethosagent/platform-discord': { DiscordAdapter: stub('discord') },
    };
    return (mods[modulePath] ?? null) as T | null;
  };
  const config = {
    provider: 'anthropic',
    model: 'm',
    apiKey: 'sk',
    personality: 'researcher',
    discordToken: 'discord-tok',
    slack: {
      apps: [
        {
          id: 'prod',
          botToken: 'xoxb-1',
          appToken: 'xapp-1',
          signingSecret: 's',
          bind: { type: 'personality', name: 'researcher' },
        },
      ],
    },
  } as unknown as EthosConfig;
  const table: RoomPolicyTable = buildRoomPolicyTable({
    channels: {
      slack: { entries: entries({ C1: { mode: 'all' }, '*dm': { prompt: 'dm' } }) },
    },
  }).table;

  it('gives each platform a view over its own entries; the others get none', async () => {
    captured.length = 0;
    await buildAdapters(config, loader, undefined, { roomPolicies: table });
    const slack = captured.find((c) => c.platform === 'slack')?.cfg;
    const discord = captured.find((c) => c.platform === 'discord')?.cfg;
    const fn = slack?.roomModeDefault as
      | ((i: { chatId: string; isDm: boolean }) => string | undefined)
      | undefined;
    expect(fn?.({ chatId: 'C1', isDm: false })).toBe('all');
    expect(fn?.({ chatId: 'C2', isDm: false })).toBeUndefined();
    expect(fn?.({ chatId: 'D1', isDm: true })).toBeUndefined();
    expect(discord).not.toHaveProperty('roomModeDefault');
  });

  it.each([
    [undefined, 'mention_only', false],
    ['observe', 'observe', true],
  ] as const)(
    'whatsapp default_mode %s -> defaultMode %s, configured %s',
    async (cfgMode, mode, configured) => {
      captured.length = 0;
      const waLoader: AdapterModuleLoader = async <T>(modulePath: string): Promise<T | null> =>
        (modulePath === '@ethosagent/platform-whatsapp'
          ? { WhatsAppAdapter: stub('whatsapp') }
          : null) as T | null;
      const waConfig = {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        whatsapp: [{ id: 'wa', ...(cfgMode ? { default_mode: cfgMode } : {}) }],
      } as unknown as EthosConfig;
      await buildAdapters(waConfig, waLoader);
      const cfg = captured.find((c) => c.platform === 'whatsapp')?.cfg;
      expect(cfg?.defaultMode).toBe(mode);
      expect(cfg?.defaultModeConfigured).toBe(configured);
    },
  );

  it('without a table no adapter gets the hook', async () => {
    captured.length = 0;
    await buildAdapters(config, loader);
    for (const c of captured) expect(c.cfg).not.toHaveProperty('roomModeDefault');
  });
});

describe('loadRoomPolicies validates a room mode per adapter enum (L12)', () => {
  async function load(channels: Record<string, ChannelsPlatformConfig>) {
    const { table, warnings } = await loadRoomPolicies(new InMemoryStorage(), {
      channels,
    } as unknown as EthosConfig);
    return { table, warnings: warnings.join('\n') };
  }

  it('drops a mode outside the platform enum with a boot warning, keeps the rest', async () => {
    const { table, warnings } = await load({
      slack: {
        entries: entries({ C1: { mode: 'regex_match', prompt: 'p' }, C2: { mode: 'all' } }),
      },
      telegram: { entries: entries({ '-100': { mode: 'regex_match' } }) },
      whatsapp: { entries: entries({ G1: { mode: 'thread_follow' }, G2: { mode: 'observe' } }) },
    });
    expect(table?.slack?.entries.C1?.mode).toBeUndefined();
    expect(table?.slack?.entries.C1?.prompt).toBe('p');
    expect(table?.slack?.entries.C2?.mode).toBe('all');
    expect(table?.telegram?.entries['-100']?.mode).toBeUndefined();
    expect(table?.whatsapp?.entries.G1?.mode).toBeUndefined();
    expect(table?.whatsapp?.entries.G2?.mode).toBe('observe');
    expect(warnings).toContain("channels.slack.C1.mode: 'regex_match'");
    expect(warnings).toContain("channels.whatsapp.G1.mode: 'thread_follow'");
    expect(warnings).toContain(
      "channels.telegram.-100.mode: 'regex_match' needs a pattern — set it at runtime with the channel-mode command — ignored.",
    );
  });

  it('accepts any mode token for a platform with no known enum (plugin channel)', async () => {
    const { table, warnings } = await load({
      matrix: { entries: entries({ '!r:hs': { mode: 'whatever' } }) },
    });
    expect(table?.matrix?.entries['!r:hs']?.mode).toBe('whatever');
    expect(warnings).toBe('');
  });
});

describe('every host that builds adapters hands them the room table (L12)', () => {
  it.each([
    'apps/ethos/src/commands/gateway.ts',
    'apps/ethos/src/commands/boot.ts',
    'apps/ethos/src/commands/boot-reload.ts',
  ])('%s passes roomPolicies to buildGatewayAdapters', async (file) => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, file), 'utf8');
    const calls = src.match(/buildGatewayAdapters\((?!\s*config: EthosConfig)[^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('roomPolicies');
  });
});
