import type { RealtimeSessionTicket } from './realtime-voice-call-client';

// Which talk-mode tier a call gets — the pure half of the decision, shared by
// the web (`apps/web/src/features/voice/talk-mode-client.ts`) and the phone.
//
// The tier is decided SERVER-side and reported by `voice.realtimeToken` — as a
// token, or as a typed reason why not. The client's rule is: a token means
// realtime, anything else means pipeline, and any reason that is not the
// configured preference is shown. What the client adds is only whether it can
// run realtime at all (its audio capabilities) and whether the user opted out.

/** What the host's audio stack can do. How it is read is per-surface. */
export interface TalkModeEnvironment {
  hasWebSocket: boolean;
  hasAudioContext: boolean;
  hasMediaDevices: boolean;
  hasScriptProcessor: boolean;
}

/** Every streaming piece must be present; one missing sends the call to batch. */
export function streamingTalkModeSupported(env: TalkModeEnvironment): boolean {
  return env.hasWebSocket && env.hasAudioContext && env.hasMediaDevices && env.hasScriptProcessor;
}

/**
 * The realtime tier needs everything the streaming pipeline tier needs — it
 * captures through the same PCM tap and plays out through the same absolute
 * scheduler. A host that cannot stream cannot do realtime either.
 */
export function realtimeTalkModeSupported(env: TalkModeEnvironment): boolean {
  return streamingTalkModeSupported(env);
}

/**
 * Whether to ask the server for a realtime credential at all. False when the
 * user chose the local pipeline (`forcePipeline`) or the batch fallback
 * (`forceBatch`), when there is no way to mint, or when the host cannot run
 * the realtime tier.
 */
export function shouldTryRealtime(
  opts: { forcePipeline?: boolean | undefined; forceBatch?: boolean | undefined; canMint: boolean },
  env: TalkModeEnvironment,
): boolean {
  if (opts.forcePipeline || opts.forceBatch || !opts.canMint) return false;
  return realtimeTalkModeSupported(env);
}

/** What `voice.realtimeToken` answered. Mirrors the RPC's output union. */
export type RealtimeTokenAnswer =
  | ({ ok: true } & RealtimeSessionTicket)
  | { ok: false; reason: string; message: string; providerId: string | null };

/**
 * Reasons the user is NOT told about, because nothing went wrong: the
 * deployment (or the personality) asked for the pipeline, or there is no
 * realtime provider configured at all. Every other reason — a refused provider,
 * an unknown roster entry, a provider that cannot issue a client credential —
 * is a downgrade the user gets told about, in the words the server chose.
 */
const SILENT_REFUSALS = new Set(['pipeline_preferred', 'not_configured']);

/**
 * What the user should be told about a realtime answer, or null for nothing.
 *
 * Pure and exported so the "never a silent downgrade" rule is a test rather
 * than a reading of the transport. The distinction it draws: a CONFIGURED
 * pipeline call is not a downgrade, and a REFUSED realtime call is — including
 * the Gemini Live case, whose provider is fine and simply cannot hand a browser
 * a credential.
 */
export function realtimeDegradeNotice(answer: RealtimeTokenAnswer): string | null {
  if (answer.ok) return null;
  return SILENT_REFUSALS.has(answer.reason) ? null : answer.message;
}
