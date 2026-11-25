// `ethos gateway start` / `ethos boot` — the per-room policy table (plan
// channel-prompts D9/D15/L12). Split out of gateway.ts. `loadAdapterModule`
// stays in gateway.ts (archcheck pins the `platform-*` imports to that path), so
// the loader is injected; gateway.ts exports the `loadRoomPolicies(storage,
// config)` both hosts call (pinned by `room-policy-host-wiring.test.ts`).

import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { RoomPolicyTable } from '@ethosagent/gateway';
import type { Storage } from '@ethosagent/types';
import { loadRoomPolicies as loadSharedRoomPolicies } from '@ethosagent/wiring';
import { c } from './_shared';
import type { AdapterModuleLoader } from './gateway-platform-readers';

const MODE_ENUM_MODULES: Record<string, readonly [string, string]> = {
  slack: ['@ethosagent/platform-slack', 'Slack'],
  discord: ['@ethosagent/platform-discord', 'Discord'],
  telegram: ['@ethosagent/platform-telegram', 'Telegram'],
  whatsapp: ['@ethosagent/platform-whatsapp', 'WhatsApp'],
};

/**
 * The reply-mode enum of each built-in platform adapter whose `channels.<platform>`
 * config sets a `mode`. Loaded lazily through the adapter loader, so a deployment
 * that sets no room `mode` pays nothing and a platform whose module will not load
 * is simply absent (accepted, not validated).
 */
async function loadRoomModeEnums(
  config: EthosConfig,
  load: AdapterModuleLoader,
): Promise<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const [platform, plat] of Object.entries(config.channels ?? {})) {
    const target = MODE_ENUM_MODULES[platform];
    if (!target || !Object.values(plat.entries).some((e) => e.mode !== undefined)) continue;
    const mod = await load<{ CHANNEL_MODES: readonly string[] }>(...target);
    if (mod) out[platform] = mod.CHANNEL_MODES;
  }
  return out;
}

type RoomModeInput = { chatId: string; threadId?: string; isDm: boolean; roomName?: string };

/**
 * `{ roomModeDefault }` for one platform, spread into its adapter config: the
 * room config's default reply mode (plan L12) as a pure view over the same table
 * and resolver the gateway uses. Empty when the table has no entries for the
 * platform, so that adapter behaves exactly as before.
 */
export function roomModeDefaultFor(
  table: RoomPolicyTable | undefined,
  platform: string,
  resolve: typeof import('@ethosagent/gateway').roomModeDefault,
): { roomModeDefault?: (input: RoomModeInput) => string | undefined } {
  if (!table?.[platform]) return {};
  return { roomModeDefault: (input) => resolve(table, { platform, ...input })?.mode };
}

/**
 * Room-policy adapter config for one platform: its `roomModeDefault` view, plus
 * `fetchMetadata` (plan channel-prompts L7: topic/name + effective mode on room
 * messages) for Slack and Discord when `channels.<platform>.fetch_metadata` is on.
 */
export function roomAdapterExtras(
  config: EthosConfig,
  table: RoomPolicyTable | undefined,
  platform: string,
  resolve: Parameters<typeof roomModeDefaultFor>[2],
) {
  const fetchMetadata =
    (platform === 'slack' || platform === 'discord') && config.channels?.[platform]?.fetchMetadata;
  return {
    ...roomModeDefaultFor(table, platform, resolve),
    ...(fetchMetadata ? { fetchMetadata: true } : {}),
  };
}

/**
 * Build the per-room policy table for a gateway host: wiring's `loadRoomPolicies`
 * (shared with the web room editor) plus the state dir and the lazily loaded
 * platform mode enums (plan channel-prompts-ui D2). The caller prints the
 * warnings (`warnRoomPolicies`).
 */
export async function loadRoomPoliciesVia(
  storage: Storage,
  config: EthosConfig,
  load: AdapterModuleLoader,
): Promise<{ table: RoomPolicyTable | undefined; warnings: string[] }> {
  return loadSharedRoomPolicies(storage, config, {
    stateDir: ethosDir(),
    modeEnums: await loadRoomModeEnums(config, load),
  });
}

/** `loadRoomPolicies(storage, config)` bound to the host's adapter loader. */
export const bindRoomPolicyLoader =
  (load: AdapterModuleLoader) => (storage: Storage, config: EthosConfig) =>
    loadRoomPoliciesVia(storage, config, load);

/** Boot-time rendering of `loadRoomPolicies` warnings, for the two gateway hosts. */
export function warnRoomPolicies(warnings: readonly string[]): void {
  for (const w of warnings) console.warn(`${c.yellow}⚠${c.reset} ${c.dim}${w}${c.reset}`);
}
