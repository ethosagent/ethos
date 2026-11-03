import { VOICE_MODES } from '@ethosagent/types';
import { oc } from '@orpc/contract';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Voice — server-side STT transcription for the web/desktop chat
// ---------------------------------------------------------------------------

const VoiceTranscribeInput = z.object({
  audio: z.string().min(1),
  mimeType: z.string().min(1),
  /** Personality listening. Without it the server cannot honour a personality's
   *  declared `voice.stt_provider` and uses the default `auxiliary.asr` entry —
   *  the mirror of `personalityId` on `voice.synthesize`. */
  personalityId: z.string().optional(),
  /** BCP-47 tag handed to the provider, when the client knows it. */
  language: z.string().optional(),
});
const VoiceTranscribeOutput = z.object({
  transcript: z.string(),
});
const VoiceSynthesizeInput = z.object({
  text: z.string().min(1),
  /** Global default voice the client read from config. The LOWEST precedence
   *  rung — the active personality's `voice.tts_voice` beats it, and a
   *  language-specific entry beats that (`resolveVoicePreferences`). */
  voice: z.string().optional(),
  /** Personality speaking this reply. Without it the server cannot honour a
   *  personality's declared voice and falls back to the global default. */
  personalityId: z.string().optional(),
  /** BCP-47 tag of the reply, selecting from the personality's language map. */
  language: z.string().optional(),
  /**
   * Audition an unsaved selection: `provider` names a
   * `voice.tts.providers.<name>` roster entry and `voice` the voice id, and
   * both BEAT the personality's own `voice` block and the global default. The
   * personality editor's Preview button uses it, since the selection it is
   * previewing is not on disk yet.
   *
   * `provider` is a roster LABEL, never a provider id or a credential — an
   * unknown label falls back to the default entry exactly as a personality's
   * would, and the egress gate still keys on the resolved provider.
   */
  override: z.object({ provider: z.string().optional(), voice: z.string().optional() }).optional(),
});
const VoiceSynthesizeOutput = z.object({
  audio: z.string(),
  format: z.enum(['opus', 'mp3', 'wav', 'pcm']),
  mimeType: z.string(),
  /** Provider id that ACTUALLY synthesized this audio. Optional so an older
   *  client that never asked for it keeps validating. */
  provider: z.string().optional(),
});

/**
 * The batch-RPC fallback tier's turn driver — for a browser that cannot
 * stream (`talk-mode-client.ts`'s `forceBatch`/no-`WebSocket` path). Drives
 * one agent turn against the SAME browser voice lane
 * (`voice:<botKey>:browser:<sessionId>`) a streaming connection for this
 * `sessionId` would use — never the typed chat session (Conflict 1,
 * plan/phases/voice-live-personality.md §7). `sessionId` here is the CHAT
 * session id this call belongs to, the same field/meaning as the streaming
 * lane's `hello.sessionId` — telemetry and lane-key derivation only, never
 * what actually persists the turn.
 */
const VoiceRunTurnInput = z.object({
  text: z.string().min(1),
  sessionId: z.string().optional(),
  personalityId: z.string().optional(),
});
const VoiceRunTurnOutput = z.object({ reply: z.string() });

/**
 * What one selectable TTS entry can do. `providerId` is the registered provider
 * the entry names (null = nothing configured). `voices` is the provider's
 * advertised `caps.voices`: a list means the voice id must come FROM it, `null`
 * means the provider takes open-ended ids (Kokoro, a `command-tts` recipe) and
 * the surface should offer free text rather than guess a list.
 */
const VoiceTtsEntrySchema = z.object({
  providerId: z.string().nullable(),
  voices: z.array(z.string()).nullable(),
});
const VoiceTtsEntriesOutput = z.object({
  /** The `auxiliary.tts` default entry — what a personality that names nothing gets. */
  default: VoiceTtsEntrySchema,
  /** `voice.tts.providers.*`, keyed by the operator's label. */
  roster: z.record(z.string(), VoiceTtsEntrySchema),
});

/**
 * One selectable STT entry. `providerId` only: an ear advertises no voice ids,
 * so there is nothing to construct a provider to read, and this procedure makes
 * no provider at all.
 */
const VoiceSttEntrySchema = z.object({ providerId: z.string().nullable() });
const VoiceSttEntriesOutput = z.object({
  /** The `auxiliary.asr` default entry — what a personality that names nothing gets. */
  default: VoiceSttEntrySchema,
  /** `voice.stt.providers.*`, keyed by the operator's label. */
  roster: z.record(z.string(), VoiceSttEntrySchema),
});

/**
 * One selectable REALTIME entry — `providerId` only, for the same reason the
 * STT one is: this procedure constructs no provider, so it can report what an
 * entry NAMES but not what it advertises.
 */
const VoiceRealtimeEntrySchema = z.object({ providerId: z.string().nullable() });
/**
 * The roster a personality's `voice.realtime_provider` picks from.
 *
 * There is no `auxiliary.*` entry under this tier the way there is under TTS
 * and STT, so instead of a synthetic "default entry" this carries the roster
 * label `voice.realtime.default` NAMES. A deployment with an empty roster has
 * no realtime tier rather than an implicit one, and the editor says so instead
 * of offering a Default that resolves to nothing.
 */
const VoiceRealtimeEntriesOutput = z.object({
  roster: z.record(z.string(), VoiceRealtimeEntrySchema),
  /** The label `voice.realtime.default` names, or null when the key is unset. */
  defaultEntryName: z.string().nullable(),
});

const VoiceRealtimeTokenInput = z.object({
  /** Personality about to talk. Its `voice.realtime_provider` picks the roster
   *  entry and its `voice.tier` decides whether the realtime tier runs at all. */
  personalityId: z.string().optional(),
});

/**
 * Why the browser is NOT getting a realtime session. Each reason renders as
 * different copy, which is the whole point of typing them: "this deployment has
 * no realtime provider" and "your local-only gate refused the one it has" are
 * the same non-event to the user unless the surface can tell them apart.
 *
 * `pipeline_preferred` is not a failure — it is the configured answer, so the
 * surface renders no notice and simply starts the pipeline call.
 */
const VoiceRealtimeRefusalReason = z.enum([
  /** `voice.tier` (personality first, then deployment) asked for the pipeline. */
  'pipeline_preferred',
  /** No realtime roster entry is configured, or none is named as the default. */
  'not_configured',
  /** The personality (or `voice.realtime.default`) names an entry this deployment lacks. */
  'unknown_entry',
  /** `voice.trustedPlugins` refuses the resolved provider — the local-only egress gate. */
  'untrusted_provider',
  /** The provider is server-relayed (`caps.ephemeralToken !== true`) — Gemini Live. */
  'no_browser_token',
  /** The provider would not construct, or the mint itself failed. */
  'provider_unavailable',
]);

/**
 * A minted browser-direct session, or a typed refusal.
 *
 * The success arm carries BOTH sample rates because the two are not necessarily
 * equal (`RealtimeVoiceCapabilities` in `@ethosagent/types`): the browser
 * captures at `inputSampleRate` and plays out at `outputSampleRate`.
 *
 * `token` is a short-lived provider credential minted for this session. The
 * operator's long-lived API key never appears here, and no part of it appears
 * in a refusal message either.
 */
const VoiceRealtimeTokenOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** The REGISTERED provider id that minted it (`openai-realtime`), never the roster label. */
    providerId: z.string(),
    /** Model the token was minted against; null when the provider pins none. */
    model: z.string().nullable(),
    token: z.string(),
    /** Absolute expiry, epoch milliseconds. Not a TTL — no clock arithmetic at the edge. */
    expiresAt: z.number(),
    /** Endpoint the browser connects to with `token`. */
    url: z.string(),
    inputSampleRate: z.number(),
    outputSampleRate: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    reason: VoiceRealtimeRefusalReason,
    /** Renderable sentence. Never carries credentials. */
    message: z.string(),
    /** The provider that was actually about to run, when one was resolved. */
    providerId: z.string().nullable(),
  }),
]);

/**
 * Per-conversation voice mode for the browser chat header.
 *
 * The mode is durable (`LaneVoiceModeStore`) and SHARED with the gateway's
 * channel lanes, so a mode set here is the same fact the gateway reads. The
 * `default` on the read is the deployment's `voice.defaultMode`: a lane with no
 * override is INHERITING, and the header says so rather than pretending the
 * inherited value was chosen.
 */
const VoiceLaneModeGetInput = z.object({ sessionId: z.string().min(1) });
const VoiceLaneModeGetOutput = z.object({
  /** The lane's effective mode — its override, or `default` when it has none. */
  mode: z.enum(VOICE_MODES),
  /** `voice.defaultMode` — what an unset lane inherits. */
  default: z.enum(VOICE_MODES),
});
const VoiceLaneModeSetInput = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(VOICE_MODES),
});
const VoiceLaneModeSetOutput = z.object({ mode: z.enum(VOICE_MODES) });

// --- Wake satellites (voice V3) ---------------------------------------------

/**
 * One connected wake satellite, as Settings → Voice renders it.
 *
 * Everything here is what the NODE reported, not what the server inferred. A
 * microphone in a room that misreports whether it is listening is a privacy
 * defect, so `state` comes from the only component that can see the capture
 * loop, `probes` carries `ethos listen doctor`'s findings so the row can name
 * the failing dependency inline, and `lastWake` is the receipt that a phrase
 * actually reached a personality.
 */
const SatelliteNodeSchema = z.object({
  nodeId: z.string(),
  laneId: z.string(),
  displayName: z.string().nullable(),
  capabilities: z.object({
    edgeStt: z.boolean(),
    playback: z.boolean(),
    captureSampleRate: z.number(),
    /** False → the SERVER matches wake phrases for this node, from the transcript. */
    phraseMatch: z.boolean(),
  }),
  state: z.enum(['listening', 'muted', 'wake_off', 'speaking', 'degraded']),
  /** Which probe failed, which device disappeared. Renders inline on the row. */
  stateDetail: z.string().nullable(),
  wakeEnabled: z.boolean(),
  probes: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().nullable() })),
  lastWake: z.object({ phrase: z.string(), personalityId: z.string(), at: z.number() }).nullable(),
  /**
   * The open addressing window: who a follow-up with no wake phrase reaches,
   * and until when. Null means the next utterance has to name somebody.
   */
  conversation: z.object({ personalityId: z.string(), until: z.number() }).nullable(),
  connectedAt: z.number(),
});

const SatellitesListOutput = z.object({ nodes: z.array(SatelliteNodeSchema) });

const SatelliteSetWakeEnabledInput = z.object({
  nodeId: z.string().min(1),
  enabled: z.boolean(),
});
/** `false` = no such node is connected. The row says "not reachable" rather
 *  than reporting a mute that never left the process. */
const SatelliteSetWakeEnabledOutput = z.object({ ok: z.boolean() });

/** One editable wake route. `id` is the yaml key, so it carries the same
 *  charset the config parser will match on the way back in. */
const WakeRouteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  phrase: z.string().min(1),
  personalityId: z.string().min(1),
  /** Route-level opt-in for a privileged personality (eng-review D13). */
  privileged: z.boolean(),
  enabled: z.boolean(),
});

/**
 * One route as READ — the effective table, which is wider than the file.
 *
 * Every unprivileged personality answers to `hey <name>` without any config, so
 * the read carries those synthesized routes alongside the configured ones and
 * `implicit` is how the editor tells them apart: configured rows are editable,
 * implicit rows are shown and not saved back. The id is only `min(1)` here
 * because a synthesized id is `auto:<personalityId>`, deliberately outside the
 * charset a config key may use — which is also why the WRITE schema above stays
 * strict and carries no `implicit` field. An implicit route is not something the
 * editor can send back.
 */
const WakeRouteViewSchema = z.object({
  id: z.string().min(1),
  phrase: z.string().min(1),
  personalityId: z.string().min(1),
  privileged: z.boolean(),
  enabled: z.boolean(),
  /** True for a `hey <name>` default; false for a `voice.wake.routes` entry. */
  implicit: z.boolean(),
});

/**
 * Deployment-wide satellite knobs, defaults already applied.
 *
 * Read-only through this namespace: the routing TABLE is what the wake-route
 * manager edits, and these scalars are a separate Settings surface. Returned on
 * the read so the manager can show what the routes will run under.
 */
const WakeSettingsSchema = z.object({
  engine: z.enum(['fallback', 'sherpa', 'openwakeword']),
  sensitivity: z.number(),
  confirmationFrames: z.number(),
  edgeStt: z.boolean(),
  idleTimeoutMs: z.number(),
  wakeEnabled: z.boolean(),
});

const WakeRoutesGetOutput = z.object({
  routes: z.array(WakeRouteViewSchema),
  settings: WakeSettingsSchema,
});

/**
 * Replace the whole route table.
 *
 * Wholesale, not a merge: a route the operator deleted has to actually stop
 * answering the door. The write round-trips through `config.yaml` and then
 * pushes to every connected satellite, so a save takes effect without a
 * restart (eng-review D5).
 */
const WakeRoutesSetInput = z.object({ routes: z.array(WakeRouteSchema) });

// ---------------------------------------------------------------------------
// Calls — read-only view of the durable telephony call log
//
// The gateway opens a row when a number rings and closes it on hang-up. This is
// the operator's window onto that: what rang, who was refused and why, what it
// cost, and whether a call is up right now.
//
// Read-only by construction: there is no RPC that starts, patches, hangs up or
// prunes a call. Dialling out and ending a live call are the agent's and the
// gateway's decisions, made against their own botKeys; a settings page must not
// be able to place a call or cut one off.
// ---------------------------------------------------------------------------

export const CallDirectionSchema = z.enum(['inbound', 'outbound']);

/** `screened` / `refused` are decisions Ethos made (not allowlisted, budget
 *  spent); `failed` is the network or the provider letting us down. An operator
 *  reading the list needs to tell "we said no" from "it broke". */
export const CallStatusSchema = z.enum([
  'ringing',
  'live',
  'completed',
  'screened',
  'refused',
  'failed',
]);

export const CallTierSchema = z.enum(['pipeline', 'realtime']);

/**
 * One row of the call list.
 *
 * Deliberately NOT the whole record: a call carries its full transcript, and a
 * 200-row list dragging 200 transcripts through the wire is the wrong shape —
 * it is slow, it is a lot of conversation sitting in a browser network log, and
 * the list renders none of it. `summaryPreview` is the post-call summary
 * truncated to 200 characters; `hasTranscript` says whether opening the row
 * will show anything. `voice.calls.get` returns the full text.
 */
export const CallSummarySchema = z.object({
  /** The provider's call id — stable for the life of the call. */
  id: z.string(),
  botKey: z.string(),
  /** `voice:<botKey>:sip:<callerId>` — the lane the turns ran in. */
  laneKey: z.string(),
  direction: CallDirectionSchema,
  fromNumber: z.string(),
  toNumber: z.string(),
  personalityId: z.string().nullable(),
  tier: CallTierSchema.nullable(),
  status: CallStatusSchema,
  /** Epoch milliseconds. */
  startedAt: z.number(),
  /** Epoch milliseconds; null while the call is still up. */
  endedAt: z.number().nullable(),
  /** Why a screened/refused call was turned away (`not_allowlisted`,
   *  `over_budget`, … or free text). Free-form on purpose — a refusal reason is
   *  shown to a human and a closed set would force a schema change per guard. */
  reason: z.string().nullable(),
  /** Post-call summary, truncated to 200 characters. Null when there is none. */
  summaryPreview: z.string().nullable(),
  /** Whether a transcript exists for this call — `get` returns it. */
  hasTranscript: z.boolean(),
  costUsd: z.number().nullable(),
});

/** One call with the text the list withholds. */
export const CallDetailSchema = CallSummarySchema.extend({
  /** The full post-call summary; null when there is none. */
  summary: z.string().nullable(),
  /** The full transcript; null when there is none. */
  transcript: z.string().nullable(),
});

export type CallDirection = z.infer<typeof CallDirectionSchema>;
export type CallStatus = z.infer<typeof CallStatusSchema>;
export type CallSummary = z.infer<typeof CallSummarySchema>;
export type CallDetail = z.infer<typeof CallDetailSchema>;

const CallsListInput = z.object({
  /** Rows to return, newest first. Clamped to 1–200 by the call log. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Keep only inbound / outbound calls. Absent = both. */
  direction: CallDirectionSchema.optional(),
  /** Keep only calls in this state. Absent = every state. */
  status: CallStatusSchema.optional(),
});

const CallsListOutput = z.object({ calls: z.array(CallSummarySchema) });

/** Live calls are `ringing` or `live`, OLDEST first — the order a "calls in
 *  progress" indicator wants (the call that has been waiting longest is the one
 *  worth looking at). */
const CallsActiveOutput = z.object({ calls: z.array(CallSummarySchema) });

const CallsGetInput = z.object({ id: z.string().min(1) });

/** `call` is null for an unknown id — a pruned or mistyped call is an empty
 *  detail pane, not an error to throw at the UI. */
const CallsGetOutput = z.object({ call: CallDetailSchema.nullable() });

/** @experimental */
export const voice = {
  transcribe: oc.input(VoiceTranscribeInput).output(VoiceTranscribeOutput),
  synthesize: oc.input(VoiceSynthesizeInput).output(VoiceSynthesizeOutput),
  /** Batch-RPC fallback tier's turn driver — runs on the browser voice lane,
   *  never the chat session. See `VoiceRunTurnInput`'s doc comment. */
  runTurn: oc.input(VoiceRunTurnInput).output(VoiceRunTurnOutput),
  /** Selectable TTS entries + the voice ids each advertises. Read-only: it
   *  constructs providers to read their caps and synthesizes nothing. */
  ttsEntries: oc.output(VoiceTtsEntriesOutput),
  /** Selectable STT entries. Read-only and construction-free. */
  sttEntries: oc.output(VoiceSttEntriesOutput),
  /** Selectable REALTIME entries. Read-only and construction-free. */
  realtimeEntries: oc.output(VoiceRealtimeEntriesOutput),
  /** Mint a browser-direct realtime credential, or say why not. */
  realtimeToken: oc.input(VoiceRealtimeTokenInput).output(VoiceRealtimeTokenOutput),
  /** Read / write ONE conversation's durable voice mode. */
  laneMode: {
    get: oc.input(VoiceLaneModeGetInput).output(VoiceLaneModeGetOutput),
    set: oc.input(VoiceLaneModeSetInput).output(VoiceLaneModeSetOutput),
  },
  /** Connected wake satellites — the Settings → Voice liveness rows. */
  satellites: {
    list: oc.output(SatellitesListOutput),
    /** Mute / unmute ONE node. The node persists it across restarts. */
    setWakeEnabled: oc.input(SatelliteSetWakeEnabledInput).output(SatelliteSetWakeEnabledOutput),
  },
  /** The wake-phrase → personality table. */
  wakeRoutes: {
    get: oc.output(WakeRoutesGetOutput),
    set: oc.input(WakeRoutesSetInput).output(WakeRoutesGetOutput),
  },
  /** Telephony call history. Read-only — see the block comment above the
   *  schemas. A deployment with no call log reports an empty list rather than
   *  failing, so the Communications tab renders an empty state, not an error. */
  calls: {
    /** Recent calls, newest first — the Communications call list. */
    list: oc.input(CallsListInput).output(CallsListOutput),
    /** In-progress calls — the live-call indicator. */
    active: oc.output(CallsActiveOutput),
    /** One call with its transcript and summary. */
    get: oc.input(CallsGetInput).output(CallsGetOutput),
  },
};
