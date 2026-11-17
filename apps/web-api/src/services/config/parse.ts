import { isVoiceChannelPlatform, normalizeAuxTimeoutSeconds } from '@ethosagent/config';
import {
  parseRealtimeRoster,
  parseSttRoster,
  parseTtsRoster,
} from '../../repositories/config.repository';
import {
  RETENTION_DURATION_RE,
  RETENTION_SUBKEYS,
  type RetentionSubkey,
  VOICE_BARGE_IN_SURFACES,
} from './constants';
import { redactKey } from './redact';
import type {
  AuxModelGetResult,
  QuickCommandGetResult,
  VoiceBargeInTuningResult,
  VoiceBotGetResult,
  VoiceFillerGetResult,
  VoiceProviderGetResult,
  VoiceRealtimeProviderGetResult,
  VoiceSttProviderGetResult,
  WebhookGetResult,
} from './types';

// -- passthrough read helpers ------------------------------------------------

export function passStr(p: Record<string, string>, key: string): string | null {
  const v = p[key];
  return v ? v : null;
}

export function passNum(p: Record<string, string>, key: string, fallback: number): number {
  const raw = p[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function passNumOrNull(p: Record<string, string>, key: string): number | null {
  const raw = p[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Like {@link passNumOrNull} but applying the SAME bound `validateSettingsPatch`
 * applies to the matching field on write — an out-of-range value reads as
 * unset, so the caller's `??` default is what gets reported.
 *
 * A hand-edited or older `config.yaml` can hold a value `@ethosagent/config`'s
 * `build*` helpers drop on load; reading it back unbounded showed the dashboard
 * a number the runtime is not using. Used only by the bounded leaves — the
 * unbounded passthrough families (e.g. `passNumOrNull`'s callers) keep {@link passNumOrNull}.
 */
export function passBoundedInt(
  p: Record<string, string>,
  key: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  const raw = p[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** {@link passBoundedInt}'s float sibling, for the one cap (`execution.docker.cpu`)
 * the loader and `checkPositive` both allow to be fractional. */
export function passPositiveNum(p: Record<string, string>, key: string): number | null {
  const raw = p[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * SHIM — `auxiliary.{asr,tts}.timeout` is seconds, but the Settings page
 * shipped it labelled and bounded in milliseconds, so a stored value may be ms.
 * The parse-site shim in `@ethosagent/config` does NOT reach here: this reads
 * the raw passthrough map, not the typed `EthosConfig.auxiliary`. Same helper,
 * second read path — so the page shows what the runtime is actually using, and
 * the operator's next Save writes it back in seconds.
 *
 * Removed with the parse-site shim (`aux-timeout-shim-removal`).
 */
export function auxTimeoutSeconds(raw: number | null): number | null {
  return raw === null ? null : normalizeAuxTimeoutSeconds(raw).seconds;
}

/** `fallback` when unset; otherwise strict `'true'` comparison. */
export function passBool(p: Record<string, string>, key: string, fallback: boolean): boolean {
  const v = p[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true';
}

/** Comma-separated list value → trimmed entries (matches packages/config splitList). */
export function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Like {@link pickEnum} but with no default — an unset key stays null. */
export function pickEnumOrNull<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | null {
  return allowed.find((a) => a === value) ?? null;
}

export function pickEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const match = allowed.find((a) => a === value);
  return match ?? fallback;
}

export function parseRetentionMap(
  p: Record<string, string>,
  prefix: string,
): Partial<Record<RetentionSubkey, string>> {
  const out: Partial<Record<RetentionSubkey, string>> = {};
  for (const sub of RETENTION_SUBKEYS) {
    const v = p[`${prefix}${sub}`];
    if (v && RETENTION_DURATION_RE.test(v)) out[sub] = v;
  }
  return out;
}

export function parsePersonalityRetention(
  p: Record<string, string>,
): Record<string, Partial<Record<RetentionSubkey, string>>> {
  const pids = new Set<string>();
  for (const key of Object.keys(p)) {
    const m = key.match(/^personalities\.([^.]+)\.retention\./);
    if (m?.[1]) pids.add(m[1]);
  }
  const out: Record<string, Partial<Record<RetentionSubkey, string>>> = {};
  for (const pid of pids) {
    const map = parseRetentionMap(p, `personalities.${pid}.retention.`);
    if (Object.keys(map).length > 0) out[pid] = map;
  }
  return out;
}

export function parseWebhooks(p: Record<string, string>): Record<string, WebhookGetResult> {
  const out: Record<string, WebhookGetResult> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(
      /^webhooks\.([^.]+)\.(personalityId|secret|sessionKey|prefilter|prefilterTimeoutSeconds|mode)$/,
    );
    const id = m?.[1];
    const field = m?.[2];
    if (!id || !field) continue;
    const slot = out[id] ?? {
      personalityId: '',
      secretPreview: '<unset>',
      sessionKey: null,
      prefilter: null,
      prefilterTimeoutSeconds: null,
      mode: 'sync' as const,
    };
    out[id] = slot;
    switch (field) {
      case 'personalityId':
        slot.personalityId = value;
        break;
      case 'secret':
        slot.secretPreview = redactKey(value);
        break;
      case 'sessionKey':
        slot.sessionKey = value || null;
        break;
      case 'prefilter':
        slot.prefilter = value || null;
        break;
      case 'prefilterTimeoutSeconds': {
        const n = Number(value);
        if (Number.isInteger(n)) slot.prefilterTimeoutSeconds = n;
        break;
      }
      case 'mode':
        if (value === 'ack') slot.mode = 'ack';
        break;
    }
  }
  return out;
}

export function parseQuickCommands(
  p: Record<string, string>,
): Record<string, QuickCommandGetResult> {
  const bag: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(/^quick_commands\.([^.]+)\.(type|command|reply|gateway|channels)$/);
    const name = m?.[1];
    const field = m?.[2];
    if (!name || !field) continue;
    const slot = bag[name] ?? {};
    bag[name] = slot;
    slot[field] = value;
  }
  const out: Record<string, QuickCommandGetResult> = {};
  for (const [name, kv] of Object.entries(bag)) {
    const gateway = kv.gateway === 'true';
    const channels = splitList(kv.channels);
    if (kv.type === 'exec' && kv.command) {
      out[name] = { type: 'exec', command: kv.command, gateway, channels };
    } else if (kv.type === 'reply' && kv.reply) {
      out[name] = { type: 'reply', reply: kv.reply, gateway, channels };
    }
  }
  return out;
}

/**
 * The named rosters, redacted for the browser.
 *
 * Entry discovery is `parseTtsRoster` / `parseSttRoster` (the repository), so
 * this surface and the VoiceService that actually speaks and listens through
 * them agree on what an entry is; the only thing added here is redaction — the
 * raw key never leaves this layer, same as `auxiliary.tts.apiKey`.
 */
export async function parseVoiceTtsProviders(
  p: Record<string, string>,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<Record<string, VoiceProviderGetResult>> {
  const out: Record<string, VoiceProviderGetResult> = {};
  for (const [name, entry] of Object.entries(parseTtsRoster(p))) {
    out[name] = {
      provider: entry.provider,
      model: entry.model ?? null,
      apiKeyPreview: await keyPreview(entry.apiKey),
      voice: entry.voice ?? null,
      baseUrl: entry.baseUrl ?? null,
      command: entry.command ?? null,
      outputFormat: entry.outputFormat ?? null,
      timeout: entry.timeout ?? null,
      maxTextLength: entry.maxTextLength ?? null,
    };
  }
  return out;
}

export async function parseVoiceSttProviders(
  p: Record<string, string>,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<Record<string, VoiceSttProviderGetResult>> {
  const out: Record<string, VoiceSttProviderGetResult> = {};
  for (const [name, entry] of Object.entries(parseSttRoster(p))) {
    out[name] = {
      provider: entry.provider,
      model: entry.model ?? null,
      apiKeyPreview: await keyPreview(entry.apiKey),
      baseUrl: entry.baseUrl ?? null,
      command: entry.command ?? null,
      timeout: entry.timeout ?? null,
    };
  }
  return out;
}

export async function parseVoiceRealtimeProviders(
  p: Record<string, string>,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<Record<string, VoiceRealtimeProviderGetResult>> {
  const out: Record<string, VoiceRealtimeProviderGetResult> = {};
  for (const [name, entry] of Object.entries(parseRealtimeRoster(p))) {
    out[name] = {
      provider: entry.provider,
      model: entry.model ?? null,
      apiKeyPreview: await keyPreview(entry.apiKey),
      baseUrl: entry.baseUrl ?? null,
      voice: entry.voice ?? null,
      costPerMinuteUsd: entry.costPerMinuteUsd ?? null,
    };
  }
  return out;
}

/**
 * `voice.channels.<platform>.ttsOut` → a flat platform→boolean map.
 *
 * Unknown platforms and non-boolean values are dropped, matching what the
 * yaml parser in `@ethosagent/config` already did to them on load — the read
 * path reports what the deployment ACTUALLY has, not what someone typed. The
 * write path is stricter; see `validateSettingsPatch`.
 */
export function parseVoiceChannelTtsOut(p: Record<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(p)) {
    const platform = key.match(/^voice\.channels\.([^.]+)\.ttsOut$/)?.[1];
    if (!platform || !isVoiceChannelPlatform(platform)) continue;
    if (value === 'true' || value === 'false') out[platform] = value === 'true';
  }
  return out;
}

/**
 * `voice.filler.*` → the tool-call filler/tick keep-alive. `enabled` defaults
 * ON (mirrors `compaction.retryOnOverflow`'s pattern); the other three stay
 * null when unset so the page can tell "never configured" from "configured
 * to the default" — the built-in numbers live in `packages/wiring`, not here.
 */
export function parseVoiceFiller(p: Record<string, string>): VoiceFillerGetResult {
  return {
    enabled: p['voice.filler.enabled'] !== 'false',
    afterMs: passNumOrNull(p, 'voice.filler.afterMs'),
    text: passStr(p, 'voice.filler.text'),
    tickIntervalMs: passNumOrNull(p, 'voice.filler.tickIntervalMs'),
  };
}

/**
 * `voice.bargeIn.<surface>.<field>` → a surface → thresholds map.
 *
 * Unknown surfaces and fields are dropped on READ, matching what the CLI's
 * parser reports for a file it refused to build a tuning from — the read path
 * describes what the deployment actually has. The write path refuses them; see
 * `validateSettingsPatch`.
 */
export function parseVoiceBargeIn(
  p: Record<string, string>,
): Record<string, VoiceBargeInTuningResult> {
  const out: Record<string, VoiceBargeInTuningResult> = {};
  for (const key of Object.keys(p)) {
    const surface = key.match(/^voice\.bargeIn\.([^.]+)\.[^.]+$/)?.[1];
    if (!surface || !(VOICE_BARGE_IN_SURFACES as readonly string[]).includes(surface)) continue;
    out[surface] ??= { energyThreshold: null, minSpeechMs: null, silenceMs: null };
  }
  for (const surface of Object.keys(out)) {
    out[surface] = {
      energyThreshold: passNumOrNull(p, `voice.bargeIn.${surface}.energyThreshold`),
      minSpeechMs: passNumOrNull(p, `voice.bargeIn.${surface}.minSpeechMs`),
      silenceMs: passNumOrNull(p, `voice.bargeIn.${surface}.silenceMs`),
    };
  }
  return out;
}

/**
 * `voice.bots.<n>.*` → the routing table, in file order.
 *
 * Indexes are sorted NUMERICALLY, not lexicographically: `Object.keys` on the
 * flat map yields strings, and the default sort would put bot 10 before bot 2 —
 * a table that reorders itself the moment a deployment has ten numbers.
 * Entries missing `match` or a complete `bind` are dropped, exactly as the CLI
 * parser drops them.
 */
export function parseVoiceBots(p: Record<string, string>): VoiceBotGetResult[] {
  const indexes = new Set<number>();
  for (const key of Object.keys(p)) {
    const idx = key.match(/^voice\.bots\.(\d+)\./)?.[1];
    if (idx !== undefined) indexes.add(Number(idx));
  }
  const bots: VoiceBotGetResult[] = [];
  for (const idx of [...indexes].sort((a, b) => a - b)) {
    const match = p[`voice.bots.${idx}.match`];
    const type = p[`voice.bots.${idx}.bind.type`];
    const name = p[`voice.bots.${idx}.bind.name`];
    if (!match || !name || (type !== 'personality' && type !== 'team')) continue;
    bots.push({
      id: passStr(p, `voice.bots.${idx}.id`),
      match,
      bind: {
        type,
        name,
        allowSlashSwitch: p[`voice.bots.${idx}.bind.allowSlashSwitch`] === 'true',
      },
    });
  }
  return bots;
}

export function parseChannelToolsets(p: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(/^channel_toolsets\.([^.]+)$/);
    if (m?.[1]) out[m[1]] = splitList(value);
  }
  return out;
}

export function parseWebSearchBackend(v: string | undefined): 'exa' | 'tavily' | 'brave' | null {
  return v === 'exa' || v === 'tavily' || v === 'brave' ? v : null;
}

export async function parseAuxModel(
  p: Record<string, string>,
  prefix: string,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<AuxModelGetResult> {
  return {
    model: passStr(p, `${prefix}.model`),
    provider: passStr(p, `${prefix}.provider`),
    apiKeyPreview: await keyPreview(p[`${prefix}.apiKey`]),
    baseUrl: passStr(p, `${prefix}.baseUrl`),
  };
}

/** Coerce the stored `display.streaming_edits` value to the enum. Unset or
 *  unrecognized falls back to the effective default, `'dms'`. */
export function parseStreamingEdits(value: string | undefined): 'off' | 'dms' | 'all' {
  return value === 'off' || value === 'all' ? value : 'dms';
}

/**
 * `browser.headed` — three-state, not a boolean. Unset or unrecognized reads as
 * `'auto'`, which is the consumer's own default; `'auto'` is NOT resolved here
 * (answering it needs an environment probe this layer must not make).
 */
export function parseBrowserHeaded(value: string | undefined): boolean | 'auto' {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'auto';
}

/** `display.call_style` — the Call Stage treatment. Unset = `personality`,
 *  which lets each personality draw its own (declared or derived). */
export function parseCallStyle(
  value: string | undefined,
): 'liquid' | 'orb' | 'rings' | 'personality' {
  return value === 'orb' || value === 'rings' || value === 'liquid' ? value : 'personality';
}

/**
 * `display.call_accent` — `personality` or a 6-digit hex. Anything else (a typo,
 * a hand-edited config) resolves to `personality` rather than reaching a canvas
 * fillStyle.
 */
export function parseCallAccent(value: string | undefined): string {
  return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value : 'personality';
}
