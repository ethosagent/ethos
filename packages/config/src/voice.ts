import type { RealtimeProviderEntry, SttProviderEntry, TtsProviderEntry } from '@ethosagent/types';
import { type BotBinding, buildBotBinding } from './builders/platforms';
import { sortedIndexes, splitList } from './builders/utils';

/**
 * Real-time voice bot binding (plan/phases/gap-voice-realtime.md §3(b),(e)).
 * Mirrors `telegram.bots[]`: one entry binds a personality/team to the voice
 * lane the bot answers. `match` is the room name or E.164 number pattern the
 * concrete transport routes on — it replaces `token`, since a voice bot has no
 * chat-platform token. The botKey derives from `id` (explicit) or `match`,
 * feeding the lane key `voice:<botKey>:<callerId>`.
 *
 * LiveKit / SIP-trunk connection keys are deliberately NOT modeled here yet;
 * they land with the concrete transport under `voice.livekit.*` / `voice.trunk.*`
 * in a later, isolated step. This step adds only the personality↔voice-bot
 * binding shape.
 */
export interface VoiceBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `match` when omitted. */
  id?: string;
  /** Room name or E.164 phone-number pattern this bot answers. */
  match: string;
  bind: BotBinding;
}

/**
 * LiveKit connection keys for the real-time voice transport
 * (plan/phases/gap-voice-realtime.md §3(b)). `url` is the LiveKit server/room
 * URL; `apiKey`/`apiSecret` are the LiveKit project credentials the token
 * minter signs access tokens with. All three are required together — a partial
 * block surfaces as a parse error. The concrete transport
 * (`@ethosagent/platform-voice`) consumes these; the native `@livekit/rtc-node`
 * / `livekit-server-sdk` bindings are supplied at the app layer, not committed.
 */
export interface VoiceLiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * SIP trunk config for telephony (plan/phases/gap-voice-realtime.md §4 Phase C).
 * A rented PSTN number + SIP trunk (Twilio/Telnyx/…) is pointed at LiveKit SIP,
 * so an inbound/outbound phone call becomes just another LiveKit participant
 * bridged into a room. This block holds the trunk-level connection facts; the
 * per-number → personality routing reuses `voice.bots[]` (a bot's `match` is an
 * E.164 number/pattern, its `bind` names the personality/team — no separate
 * mapping structure).
 *
 * `provider` + `trunkId` are required together. `password`, like
 * `voice.livekit.apiSecret`, is read as a literal — the concrete SIP binding
 * (`livekit-server-sdk` SIP API) is supplied at the app layer, not committed.
 */
export interface VoiceTrunkConfig {
  /** Telephony trunk provider bridged into LiveKit SIP. Selects which inbound
   *  webhook signature scheme the listener verifies with — the providers do not
   *  agree on how a request is signed, so this is the one fact the verifier
   *  cannot infer from the payload. */
  provider: 'twilio' | 'telnyx' | 'generic' | 'livekit';
  /** LiveKit SIP trunk id the number is attached to (inbound + outbound). */
  trunkId: string;
  /** Caller-ID number presented on outbound `call` (E.164). Optional. */
  fromNumber?: string;
  /** SIP registrar/auth username for outbound trunk auth. Optional. */
  username?: string;
  /** SIP auth password/token. Optional; read as a literal (like apiSecret). */
  password?: string;
  /**
   * Shared secret the inbound-webhook listener verifies the trunk's signature
   * against. Separate from `password`: that one authenticates US to the trunk
   * on an outbound leg, this one authenticates the TRUNK to us on an inbound
   * one, and a deployment that rotates one must not be forced to rotate the
   * other. Externalized to the vault exactly like `password`.
   */
  webhookSecret?: string;
  /**
   * HTTP path the gateway's inbound listener mounts the trunk webhook at, e.g.
   * `/voice/inbound`. Must start with `/`. Left undefined when absent — the
   * default belongs to the listener that serves the route, not to the parser
   * that reads the file.
   */
  webhookPath?: string;
  /**
   * Preferred call codec. `opus` where the trunk carries it (wideband, the
   * better ear), `g711` for the narrowband PSTN fallback every trunk speaks.
   * Absent leaves the choice to the bridge's own negotiation.
   */
  codec?: 'opus' | 'g711';
}

/**
 * Inbound-call policy: who gets through, what it may cost, and who hears about
 * it (plan/phases/voice-v4-telephony.md — inbound hardening).
 *
 * A phone number is the one surface strangers can reach without being invited,
 * so the answering rules are DEPLOYMENT facts, not personality identity: the
 * same receptionist personality behind a personal line and behind a business
 * line should reasonably disagree about allowlists, budgets and who to notify.
 */
export interface VoiceInboundConfig {
  /**
   * Caller numbers treated as known for `prewarm: 'allowlisted'`. Caller ID is
   * set by the calling party, so a match is a hint and never reaches the
   * owner's own personality (INB-001b, `decideInboundCall` in
   * `@ethosagent/platform-voice`). E.164 patterns using the same `*` wildcard grammar as
   * `voice.bots[].match` (`matchesVoicePattern`), so one grammar governs every
   * number match in the system.
   *
   * Absent = no allowlist configured, which the consumer reads as "screen
   * everyone through the receptionist". An operator wanting an explicitly
   * EMPTY allowlist cannot express it here: a flat `key: value` line with no
   * value does not parse, so absent and empty are the same file. Say
   * `voice.inbound.receptionist` instead — that IS the empty-allowlist policy.
   */
  allowlist?: string[];
  /** Personality id answering callers that are not on the allowlist. Runs in a
   *  restricted scope — no owner memory, no privileged tools. */
  receptionist?: string;
  /** Ceiling on concurrent inbound calls; over-cap callers get busy handling.
   *  Positive integer. Absent = the consumer's default (2). */
  concurrencyCap?: number;
  /** Per-caller call ceiling inside a rolling hour — the anti-hammering knob.
   *  Positive integer. */
  perCallerPerHour?: number;
  /** Daily spend ceiling in USD across all inbound calls. Positive number. */
  dailyBudgetUsd?: number;
  /**
   * Which callers get the realtime provider socket opened during ring.
   * `allowlisted` (known callers only — pre-warm where the call is almost
   * certainly worth answering), `none` (always warm on answer), `all` (warm
   * every ring, and pay for the ones that get screened).
   */
  prewarm?: 'allowlisted' | 'none' | 'all';
  /**
   * Where call summaries and capacity/refusal notices are delivered. `platform`
   * and `chatId` are required together — a destination missing either half is a
   * parse error rather than a half-built route that silently drops the one
   * notification the operator configured this block to receive.
   */
  owner?: { platform: string; chatId: string; botKey?: string };
}

/**
 * The audio surfaces whose barge-in sensitivity tunes separately.
 *
 * Three, since L1 (plan §7 "Conflict 2"): the browser talk lane's pipeline tier
 * now runs on the SAME `VoiceSession` orchestrator as `call`/`satellite`, so it
 * gets the same tuner. `voice.bargeIn.browser` always wins when present; the
 * legacy flat `display.voice_*` keys (Settings → Voice → Advanced voice
 * tuning) are read through as a fallback ONLY when `voice.bargeIn.browser` is
 * absent — see `readLegacyBrowserBargeInTuning` in
 * `apps/web-api/src/services/config.service.ts`. `display.voice_speech_threshold`
 * / `display.voice_speech_min_ms` have no counterpart here: they tuned the
 * browser's own local endpointer, which the streaming pipeline lane no longer
 * has.
 */
export type VoiceBargeInSurface = 'call' | 'satellite' | 'browser';

/** Barge-in / VAD thresholds for one surface. Every field optional — an
 *  operator tunes the one knob a room is wrong about, not all three. */
export interface VoiceBargeInTuning {
  /** Input energy above which the caller counts as speaking, 0 < x <= 1. */
  energyThreshold?: number;
  /** Milliseconds of speech before a barge-in is believed. Positive integer. */
  minSpeechMs?: number;
  /** Milliseconds of silence that end an utterance. Positive integer. */
  silenceMs?: number;
}

/**
 * Per-surface barge-in sensitivity. A phone line is noisier than a room and a
 * satellite sits across that room, so one global threshold is wrong on at least
 * one of the two — this is the config that lets each be right.
 *
 * Partial on purpose: only the surfaces the operator declared are present, so a
 * consumer can tell "tuned to this" from "never tuned" and apply its own
 * default to the rest.
 */
export type VoiceBargeInConfig = Partial<Record<VoiceBargeInSurface, VoiceBargeInTuning>>;

/**
 * `voice.filler.*` — the spoken/tick keep-alive `VoiceSession` plays during a
 * long tool call (`extensions/voice-session/src/voice-session.ts`). A SETTING,
 * not personality identity (plan/phases/voice-live-personality.md §9): the
 * line and its cadence are the operator's call, the same as barge-in tuning,
 * and apply uniformly across every lane (call, satellite, browser) — unlike
 * `bargeIn`, there is no per-surface split, because the gap this covers (a
 * silent tool call) is the same gap on every surface.
 */
export interface VoiceFillerConfig {
  /** Master switch. Absent = true = on. */
  enabled?: boolean;
  /** Debounce (ms) before speaking the filler line. Absent = the built-in default. */
  afterMs?: number;
  /** Spoken filler text. Absent = the built-in default. */
  text?: string;
  /** Repeat interval (ms) for the non-speech tick cue. Absent = the built-in default. */
  tickIntervalMs?: number;
}

/**
 * One wake-phrase → personality route (`voice.wake.routes.<id>`).
 *
 * Lives here, next to `VoiceBotConfig` / `VoiceTrunkConfig`, rather than in
 * `@ethosagent/types`: a wake route is a DEPLOYMENT routing fact the operator
 * writes in `config.yaml`, not a runtime contract the kernel resolves. Nothing
 * in `packages/core` reads it — which is exactly why `TtsProviderEntry` had to
 * live in contracts and this does not.
 */
export interface WakeRouteConfig {
  /** The spoken trigger, e.g. `hey engineer`. */
  phrase: string;
  /** Personality id this phrase wakes. Validated against the registry at dispatch. */
  personality: string;
  /**
   * Opt-in for a PRIVILEGED personality (eng-review D13). The default wake
   * surface exposes only unprivileged personalities: anyone within earshot can
   * trigger a wake, so a personality with consequential tools must be named
   * explicitly here before a voice from across the room can reach it. Absent =
   * false = not wake-reachable if the personality is privileged.
   */
  privileged?: boolean;
  /** Route off without deleting it. Absent = enabled. */
  enabled?: boolean;
}

/** `personality` or a 6-digit hex. Anything else is dropped, not coerced. */
export function parseCallAccent(v: string | undefined): string | undefined {
  if (v === 'personality') return v;
  return v !== undefined && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
}

/**
 * Platform ids that may carry a `voice.channels.<platform>.ttsOut` override —
 * the channels that have an adapter able to act on it. Anything else is
 * ignored on read.
 */
export const VOICE_CHANNEL_PLATFORMS = [
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'email',
] as const;

/** Exported so the RPC boundary (web-api's ConfigService) can REFUSE a platform
 *  id this parser would silently drop, rather than keeping a second list. */
export function isVoiceChannelPlatform(v: string): boolean {
  return (VOICE_CHANNEL_PLATFORMS as readonly string[]).includes(v);
}

/**
 * `voice.wake.routes.<id>` — phrase → personality.
 *
 * A route missing `phrase` OR `personality` is DROPPED entirely rather than
 * half-built: a phrase-less route can never fire and a personality-less one
 * would wake nothing, so keeping the remnant would hide the typo behind an
 * entry that looks configured in the Settings UI.
 */
export function buildWakeRoutes(
  kv: Record<string, Record<string, string>>,
): Record<string, WakeRouteConfig> | undefined {
  const out: Record<string, WakeRouteConfig> = {};
  for (const [id, fields] of Object.entries(kv)) {
    const phrase = fields.phrase;
    const personality = fields.personality;
    if (!phrase || !personality) continue;
    // `privileged` and `enabled` stay ABSENT unless written: the consumer must
    // be able to tell "operator said no" from "operator never said".
    out[id] = {
      phrase,
      personality,
      ...(fields.privileged === 'true'
        ? { privileged: true }
        : fields.privileged === 'false'
          ? { privileged: false }
          : {}),
      ...(fields.enabled === 'true'
        ? { enabled: true }
        : fields.enabled === 'false'
          ? { enabled: false }
          : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `voice.wake.nodes.<id>` — per-satellite overrides. An entry with no
 *  recognised field is dropped rather than kept as an empty object. */
export function buildWakeNodes(
  kv: Record<string, Record<string, string>>,
): Record<string, { inputDevice?: string; enabled?: boolean }> | undefined {
  const out: Record<string, { inputDevice?: string; enabled?: boolean }> = {};
  for (const [id, fields] of Object.entries(kv)) {
    const entry = {
      ...(fields.inputDevice ? { inputDevice: fields.inputDevice } : {}),
      ...(fields.enabled === 'true'
        ? { enabled: true }
        : fields.enabled === 'false'
          ? { enabled: false }
          : {}),
    };
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isAudioFormat(v: string | undefined): v is 'opus' | 'mp3' | 'wav' | 'pcm' {
  return v === 'opus' || v === 'mp3' || v === 'wav' || v === 'pcm';
}

// ---------------------------------------------------------------------------
// Voice provider entries — ONE builder and ONE serializer, parameterised by
// field set.
//
// There are five places an entry shape is read or written: the default TTS
// entry (`auxiliary.tts`), the TTS roster (`voice.tts.providers.<name>`), the
// default STT entry (`auxiliary.asr`), the STT roster
// (`voice.stt.providers.<name>`), and the realtime roster
// (`voice.realtime.providers.<name>`, which has no `auxiliary.*` default —
// `voice.realtime.default` names one of its own entries instead). Five
// hand-written field lists would be five chances for a roster to quietly stop
// supporting a field its default still has. So the field set is DATA — a spec
// keyed to the entry interface, checked by the compiler — and the code that
// walks it is written once.
// ---------------------------------------------------------------------------

/**
 * One field of a voice-provider entry. `name` is constrained to a key of `E`
 * other than `provider` (which every entry has and which is always written
 * first), so a spec cannot name a field the interface does not carry.
 */
interface VoiceEntryFieldSpec<E> {
  name: Exclude<keyof E, 'provider'> & string;
  kind: 'string' | 'audioFormat' | 'positiveNumber';
}

export const TTS_ENTRY_FIELDS: readonly VoiceEntryFieldSpec<TtsProviderEntry>[] = [
  { name: 'model', kind: 'string' },
  { name: 'apiKey', kind: 'string' },
  { name: 'voice', kind: 'string' },
  { name: 'baseUrl', kind: 'string' },
  { name: 'command', kind: 'string' },
  { name: 'outputFormat', kind: 'audioFormat' },
  { name: 'timeout', kind: 'positiveNumber' },
  { name: 'maxTextLength', kind: 'positiveNumber' },
];

export const STT_ENTRY_FIELDS: readonly VoiceEntryFieldSpec<SttProviderEntry>[] = [
  { name: 'model', kind: 'string' },
  { name: 'apiKey', kind: 'string' },
  { name: 'baseUrl', kind: 'string' },
  { name: 'command', kind: 'string' },
  { name: 'timeout', kind: 'positiveNumber' },
];

/**
 * No `command` and no `timeout`: a realtime provider is a duplex SESSION, not a
 * request you shell out for and time out. `costPerMinuteUsd` rides the existing
 * `positiveNumber` kind, so a rate of `0` reads as absent — which is what it
 * means for accrual, since a free minute costs nothing to charge.
 */
export const REALTIME_ENTRY_FIELDS: readonly VoiceEntryFieldSpec<RealtimeProviderEntry>[] = [
  { name: 'model', kind: 'string' },
  { name: 'apiKey', kind: 'string' },
  { name: 'baseUrl', kind: 'string' },
  { name: 'voice', kind: 'string' },
  { name: 'costPerMinuteUsd', kind: 'positiveNumber' },
];

/**
 * One entry from its flat `<field>: <value>` map. No `provider` → no entry: an
 * entry that names nothing resolvable is dropped rather than half-built.
 *
 * The single `as E` is backed by the compiler: `VoiceEntryFieldSpec<E>` only
 * admits names that are keys of `E`, and every value written is one of the
 * kinds those keys declare.
 */
export function buildVoiceProviderEntry<E extends { provider: string }>(
  kv: Record<string, string>,
  fields: readonly VoiceEntryFieldSpec<E>[],
): E | undefined {
  if (!kv.provider) return undefined;
  const out: Record<string, string | number> = { provider: kv.provider };
  for (const field of fields) {
    const raw = kv[field.name];
    if (!raw) continue;
    if (field.kind === 'positiveNumber') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) out[field.name] = n;
    } else if (field.kind === 'audioFormat') {
      if (isAudioFormat(raw)) out[field.name] = raw;
    } else {
      out[field.name] = raw;
    }
  }
  return out as E;
}

/**
 * Serialize one entry under `prefix` (`auxiliary.tts`, `auxiliary.asr`, or a
 * `voice.<kind>.providers.<name>` roster key). The write-side mirror of
 * {@link buildVoiceProviderEntry}, walking the SAME spec — a round-trip cannot
 * lose a field on only one of the two paths.
 */
export function voiceProviderEntryLines<E extends { provider: string }>(
  prefix: string,
  entry: E,
  fields: readonly VoiceEntryFieldSpec<E>[],
): string[] {
  const lines = [`${prefix}.provider: ${entry.provider}`];
  for (const field of fields) {
    const value = entry[field.name];
    if (!value) continue;
    lines.push(`${prefix}.${field.name}: ${String(value)}`);
  }
  return lines;
}

/** A whole roster (`voice.tts.providers.*` / `voice.stt.providers.*`). */
export function buildVoiceProviderRoster<E extends { provider: string }>(
  kv: Record<string, Record<string, string>>,
  fields: readonly VoiceEntryFieldSpec<E>[],
): Record<string, E> | undefined {
  const out: Record<string, E> = {};
  for (const [name, entryKv] of Object.entries(kv)) {
    const entry = buildVoiceProviderEntry(entryKv, fields);
    if (entry) out[name] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildVoiceBots(kv: Record<number, Record<string, string>>): {
  bots: VoiceBotConfig[];
  errors: string[];
} {
  const bots: VoiceBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `voice.bots[${idx}]`;
    if (!entry.match) {
      errors.push(`${label}: missing required field 'match'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    bots.push({ match: entry.match, bind: result.bind, ...(entry.id ? { id: entry.id } : {}) });
  }
  return { bots, errors };
}

export function buildVoiceLiveKit(kv: Record<string, string>): {
  livekit?: VoiceLiveKitConfig;
  errors: string[];
} {
  // Absent block is valid — LiveKit keys are optional.
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const { url, apiKey, apiSecret } = kv;
  if (!url || !apiKey || !apiSecret) {
    if (!url) errors.push("voice.livekit: missing required field 'url'.");
    if (!apiKey) errors.push("voice.livekit: missing required field 'apiKey'.");
    if (!apiSecret) errors.push("voice.livekit: missing required field 'apiSecret'.");
    return { errors };
  }
  return { livekit: { url, apiKey, apiSecret }, errors: [] };
}

const VOICE_TRUNK_PROVIDERS = ['twilio', 'telnyx', 'generic', 'livekit'] as const;

const VOICE_TRUNK_CODECS = ['opus', 'g711'] as const;

export function buildVoiceTrunk(kv: Record<string, string>): {
  trunk?: VoiceTrunkConfig;
  errors: string[];
} {
  // Absent block is valid — SIP trunk keys are optional.
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const { provider, trunkId, fromNumber, username, password, webhookSecret, webhookPath, codec } =
    kv;
  if (!provider) errors.push("voice.trunk: missing required field 'provider'.");
  else if (!(VOICE_TRUNK_PROVIDERS as readonly string[]).includes(provider)) {
    errors.push(
      `voice.trunk: invalid provider '${provider}' (expected one of: ${VOICE_TRUNK_PROVIDERS.join(', ')}).`,
    );
  }
  if (!trunkId) errors.push("voice.trunk: missing required field 'trunkId'.");
  if (webhookPath !== undefined && !webhookPath.startsWith('/')) {
    errors.push(`voice.trunk.webhookPath: must start with '/' (got '${webhookPath}').`);
  }
  if (codec !== undefined && !(VOICE_TRUNK_CODECS as readonly string[]).includes(codec)) {
    errors.push(
      `voice.trunk.codec: invalid codec '${codec}' (expected one of: ${VOICE_TRUNK_CODECS.join(', ')}).`,
    );
  }
  if (errors.length > 0) return { errors };
  return {
    trunk: {
      provider: provider as VoiceTrunkConfig['provider'],
      trunkId,
      ...(fromNumber ? { fromNumber } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(codec ? { codec: codec as VoiceTrunkConfig['codec'] } : {}),
    },
    errors: [],
  };
}

const VOICE_PREWARM_MODES = ['allowlisted', 'none', 'all'] as const;
const VOICE_INBOUND_FIELDS = [
  'allowlist',
  'receptionist',
  'concurrencyCap',
  'perCallerPerHour',
  'dailyBudgetUsd',
  'prewarm',
] as const;
const VOICE_INBOUND_OWNER_FIELDS = ['platform', 'chatId', 'botKey'] as const;

/**
 * `voice.inbound.*` — who reaches the number and what answering may cost.
 *
 * Loud rather than lenient, unlike the `voice.wake.*` knobs above: a dropped
 * wake threshold costs a slightly worse match, while a dropped budget or
 * concurrency cap costs real money on a surface strangers can dial. Every
 * malformed value is a parse error naming its own key.
 */
export function buildVoiceInbound(
  kv: Record<string, string>,
  ownerKv: Record<string, string>,
): { inbound?: VoiceInboundConfig; errors: string[] } {
  if (Object.keys(kv).length === 0 && Object.keys(ownerKv).length === 0) return { errors: [] };
  const errors: string[] = [];
  for (const field of Object.keys(kv)) {
    if (!(VOICE_INBOUND_FIELDS as readonly string[]).includes(field)) {
      errors.push(
        `voice.inbound.${field}: unknown field (expected one of: ${VOICE_INBOUND_FIELDS.join(', ')}).`,
      );
    }
  }
  for (const field of Object.keys(ownerKv)) {
    if (!(VOICE_INBOUND_OWNER_FIELDS as readonly string[]).includes(field)) {
      errors.push(
        `voice.inbound.owner.${field}: unknown field (expected one of: ${VOICE_INBOUND_OWNER_FIELDS.join(', ')}).`,
      );
    }
  }
  /** A count is a positive integer; zero and fractions are refusals, not caps. */
  const positiveInt = (field: string): number | undefined => {
    const raw = kv[field];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`voice.inbound.${field}: must be a positive integer (got '${raw}').`);
      return undefined;
    }
    return n;
  };
  const concurrencyCap = positiveInt('concurrencyCap');
  const perCallerPerHour = positiveInt('perCallerPerHour');
  let dailyBudgetUsd: number | undefined;
  if (kv.dailyBudgetUsd !== undefined) {
    const n = Number(kv.dailyBudgetUsd);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(
        `voice.inbound.dailyBudgetUsd: must be a positive number (got '${kv.dailyBudgetUsd}').`,
      );
    } else {
      dailyBudgetUsd = n;
    }
  }
  if (
    kv.prewarm !== undefined &&
    !(VOICE_PREWARM_MODES as readonly string[]).includes(kv.prewarm)
  ) {
    errors.push(
      `voice.inbound.prewarm: invalid value '${kv.prewarm}' (expected one of: ${VOICE_PREWARM_MODES.join(', ')}).`,
    );
  }
  const { platform, chatId, botKey } = ownerKv;
  if (Object.keys(ownerKv).length > 0) {
    if (!platform) errors.push("voice.inbound.owner: missing required field 'platform'.");
    if (!chatId) errors.push("voice.inbound.owner: missing required field 'chatId'.");
  }
  if (errors.length > 0) return { errors };
  const allowlist = splitList(kv.allowlist);
  return {
    inbound: {
      ...(allowlist.length > 0 ? { allowlist } : {}),
      ...(kv.receptionist ? { receptionist: kv.receptionist } : {}),
      ...(concurrencyCap !== undefined ? { concurrencyCap } : {}),
      ...(perCallerPerHour !== undefined ? { perCallerPerHour } : {}),
      ...(dailyBudgetUsd !== undefined ? { dailyBudgetUsd } : {}),
      ...(kv.prewarm ? { prewarm: kv.prewarm as VoiceInboundConfig['prewarm'] } : {}),
      ...(platform && chatId ? { owner: { platform, chatId, ...(botKey ? { botKey } : {}) } } : {}),
    },
    errors: [],
  };
}

const VOICE_BARGE_IN_SURFACES = ['call', 'satellite', 'browser'] as const;
const VOICE_BARGE_IN_FIELDS = ['energyThreshold', 'minSpeechMs', 'silenceMs'] as const;

/**
 * `voice.bargeIn.<surface>.<field>` — VAD thresholds per audio surface.
 *
 * Loud for the same reason `voice.inbound` is: a threshold typed against a
 * misspelled surface or field is not "a slightly different setting", it is no
 * setting at all, and the operator would only find out from a line the agent
 * kept talking over.
 */
export function buildVoiceBargeIn(kv: Record<string, Record<string, string>>): {
  bargeIn?: VoiceBargeInConfig;
  errors: string[];
} {
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const out: VoiceBargeInConfig = {};
  for (const [surface, fields] of Object.entries(kv)) {
    if (!(VOICE_BARGE_IN_SURFACES as readonly string[]).includes(surface)) {
      errors.push(
        `voice.bargeIn.${surface}: unknown surface (expected one of: ${VOICE_BARGE_IN_SURFACES.join(', ')}).`,
      );
      continue;
    }
    const tuning: VoiceBargeInTuning = {};
    for (const [field, raw] of Object.entries(fields)) {
      const key = `voice.bargeIn.${surface}.${field}`;
      if (field === 'energyThreshold') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || n > 1) {
          errors.push(`${key}: must be a number in (0, 1] (got '${raw}').`);
        } else {
          tuning.energyThreshold = n;
        }
      } else if (field === 'minSpeechMs' || field === 'silenceMs') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          errors.push(`${key}: must be a positive integer (got '${raw}').`);
        } else {
          tuning[field] = n;
        }
      } else {
        errors.push(
          `${key}: unknown field (expected one of: ${VOICE_BARGE_IN_FIELDS.join(', ')}).`,
        );
      }
    }
    out[surface as VoiceBargeInSurface] = tuning;
  }
  if (errors.length > 0) return { errors };
  return { bargeIn: out, errors: [] };
}
