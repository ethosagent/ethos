import type { PersonalityConfig } from '@ethosagent/types';
import type { EditableVoiceConfig, UpdatePersonalityPatch } from './types';

/** The editable STRING sub-keys, in one place — the merge walks exactly this
 *  list. `call_style` and `tier` are merged separately: they are enums, and a
 *  loop that assigns across a union of value types does not typecheck. */
const EDITABLE_VOICE_KEYS = [
  'tts_provider',
  'stt_provider',
  'realtime_provider',
  'tts_voice',
  'model',
] as const;

/**
 * Apply an editable `display` patch to the stored `display` block. Mirrors
 * `mergeVoiceConfig`'s clearing convention per sub-key (`''` clears,
 * `undefined` leaves, anything else sets), so an avatar pick never drops the
 * emoji and vice versa. A block with no sub-keys left is `undefined`.
 */
export function mergeDisplayConfig(
  existing: PersonalityConfig['display'],
  patch: { avatar_url?: string; emoji?: string } | undefined,
): PersonalityConfig['display'] {
  if (patch === undefined) return existing;
  const next: { avatar_url?: string; emoji?: string } = { ...existing };
  for (const key of ['avatar_url', 'emoji'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === '') delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Apply a `decisions` patch to the stored block. `provider: ''` clears the
 * reference, `undefined` leaves it, anything else sets it; `sites` is merged
 * per site so a patch carrying one site keeps the rest. A block left empty is
 * dropped rather than written empty (the `mergeVoiceConfig` rule).
 */
export function mergeDecisionsConfig(
  existing: PersonalityConfig['decisions'],
  patch: UpdatePersonalityPatch['decisions'],
): PersonalityConfig['decisions'] {
  if (patch === undefined) return existing;
  const next: import('@ethosagent/types').PersonalityDecisionsConfig = { ...existing };
  if (patch.provider !== undefined) {
    if (patch.provider === '') delete next.provider;
    else next.provider = patch.provider;
  }
  if (patch.sites !== undefined) {
    const sites = { ...existing?.sites, ...patch.sites };
    if (Object.keys(sites).length > 0) next.sites = sites;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Apply an editable voice patch to the stored `voice` block.
 *
 * `''` clears a scalar sub-key, `undefined` leaves it, anything else sets it.
 * `languages` is the one non-scalar: a patch that carries it REPLACES the
 * stored map, because merging per tag would leave no way to delete one — and a
 * patch that omits it still leaves a hand-written map alone.
 * A block left with nothing in it is dropped rather than written empty.
 */
export function mergeVoiceConfig(
  existing: import('@ethosagent/types').PersonalityVoiceConfig | undefined,
  patch: EditableVoiceConfig,
): import('@ethosagent/types').PersonalityVoiceConfig | undefined {
  const next: import('@ethosagent/types').PersonalityVoiceConfig = { ...existing };
  for (const key of EDITABLE_VOICE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === '') delete next[key];
    else next[key] = value;
  }
  if (patch.call_style !== undefined) {
    if (patch.call_style === '') delete next.call_style;
    else next.call_style = patch.call_style;
  }
  if (patch.tier !== undefined) {
    if (patch.tier === '') delete next.tier;
    else next.tier = patch.tier;
  }
  if (patch.languages !== undefined) {
    const languages = patch.languages;
    if (Object.keys(languages).length === 0) delete next.languages;
    else next.languages = { ...languages };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
