import type { VoiceCallStatus } from './voice-call-reducer';

/**
 * Which provider is worth naming right now: the one currently doing the work.
 * Exported so the Call Stage prints the SAME label as the strip it collapses
 * into, rather than a second opinion about which engine is running.
 */
export function providerSummary(opts: {
  status: VoiceCallStatus;
  sttProvider?: string | null;
  sttModel?: string | null;
  ttsProvider?: string | null;
  ttsModel?: string | null;
  realtimeProvider?: string | null;
  realtimeModel?: string | null;
}): string {
  // On the realtime tier ONE provider both hears and speaks, so there is no
  // listening/speaking split to pick between.
  if (opts.realtimeProvider) {
    return opts.realtimeModel
      ? `${opts.realtimeProvider} · ${opts.realtimeModel}`
      : opts.realtimeProvider;
  }
  const speaking = opts.status === 'agent_speaking' || opts.status === 'interrupted';
  if (speaking && opts.ttsProvider) {
    return opts.ttsModel ? `${opts.ttsProvider} · ${opts.ttsModel}` : opts.ttsProvider;
  }
  if (opts.sttProvider) {
    return opts.sttModel ? `${opts.sttProvider} · ${opts.sttModel}` : opts.sttProvider;
  }
  return '';
}
