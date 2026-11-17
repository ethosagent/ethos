import type { EthosConfig } from './config-types';

// Side-table keyed by the EthosConfig object identity. Avoids polluting
// the public type with an `@internal` field that downstream code would
// have to remember to ignore.
export const parseErrorsByConfig = new WeakMap<EthosConfig, string[]>();

// The NON-fatal sibling: notices the parse can emit without the config being
// wrong. Kept out of `parseErrors` because the gateway exits non-zero on any
// entry there, and a boot warning that boots nothing is worse than the thing
// it warns about.
export const parseWarningsByConfig = new WeakMap<EthosConfig, string[]>();

// UD1/B3 — whether the FILE set `personality:` at all. `parseConfigYaml` bakes
// `DEFAULT_PERSONALITY_ID` into the field (so every reader sees a usable id),
// which would make `resolveEffectiveConfig`'s `source: 'default'` unreachable
// for parsed configs; this side-table records key ABSENCE at parse time so the
// resolver can still tell "the file chose it" from "the parser defaulted it".
// Same identity-keyed pattern (and the same caveat about copies) as
// `parseWarningsByConfig`. Cleared by `migrateActiveContextPersonality`, which
// sets an explicit personality.
export const personalityDefaultedByConfig = new WeakSet<EthosConfig>();

/**
 * Parse-time notices for a config returned by {@link readRawConfig} — the read
 * side of the two side-tables, for commands that read the raw config instead of
 * going through {@link loadConfigStrict} (`ethos doctor`).
 */
/**
 * The platforms this config puts into observe mode.
 *
 * Observe mode records group chats the agent never answers. That recording
 * needs a `ChannelTranscriptStore` wired into the Gateway — without one the
 * gateway's observe gate degrades to a drop, and the messages are gone. The
 * gateway command always wires the store, so this is here for the deployments
 * that assemble a `Gateway` themselves: they pass the result as
 * `GatewayConfig.observeModePlatforms`, and the Gateway warns at construction
 * if it has one without the other.
 *
 * Reads the three per-bot default-mode keys config.yaml can express:
 * `whatsapp.<i>.default_mode`, `telegram.bots.<i>.defaultChannelMode`,
 * `slack.apps.<i>.defaultChannelMode` and — Discord being single-bot — the
 * top-level `discord.defaultChannelMode`. None of the four platforms'
 * PER-CHAT overrides are visible here — those live in
 * stores the adapters own — so a bot switched to observe by
 * `/ethos channel-mode observe` alone does not appear. This is the configured
 * default, which is what an operator writes down and what a boot-time check
 * can see.
 */
export function observeModePlatforms(config: EthosConfig): string[] {
  const platforms = new Set<string>();
  for (const entry of config.whatsapp ?? []) {
    if (entry.default_mode === 'observe') platforms.add('whatsapp');
  }
  for (const bot of config.telegram?.bots ?? []) {
    if (bot.defaultChannelMode === 'observe') platforms.add('telegram');
  }
  for (const app of config.slack?.apps ?? []) {
    if (app.defaultChannelMode === 'observe') platforms.add('slack');
  }
  if (config.discord?.defaultChannelMode === 'observe') platforms.add('discord');
  return [...platforms];
}

export function configParseNotices(config: EthosConfig): { errors: string[]; warnings: string[] } {
  return {
    errors: parseErrorsByConfig.get(config) ?? [],
    warnings: parseWarningsByConfig.get(config) ?? [],
  };
}

/**
 * Carry the identity-keyed side-tables across a config copy.
 *
 * Parse-time notices (`parseErrorsByConfig`, `parseWarningsByConfig`) and the
 * personality-key-absence record (`personalityDefaultedByConfig`) are keyed by
 * the parsed config OBJECT's identity, so any `{ ...config }` clone silently
 * sheds them — `ethos chat` dropped the B2 unknown-key warnings this way while
 * `ethos status`/`ethos doctor` (which read the original object) showed them.
 * Every code path that copies a loaded config and later feeds the copy to a
 * notices reader (`configParseNotices`, `resolveEffectiveConfig`) must call
 * this on the copy. Adoption shares the same arrays by reference — notices
 * describe the parse, not the copy's overrides, so divergence is not a concern.
 */
export function adoptConfigNotices(target: EthosConfig, source: EthosConfig): void {
  if (target === source) return;
  const errors = parseErrorsByConfig.get(source);
  if (errors !== undefined) parseErrorsByConfig.set(target, errors);
  const warnings = parseWarningsByConfig.get(source);
  if (warnings !== undefined) parseWarningsByConfig.set(target, warnings);
  if (personalityDefaultedByConfig.has(source)) personalityDefaultedByConfig.add(target);
}
