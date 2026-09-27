// Lifted to @ethosagent/voice-client (shared with the phone). Kept as a thin
// re-export so web imports do not change.
export {
  createRealtimeVoiceCallClient,
  RealtimeSampleRateError,
  type RealtimeSessionTicket,
  type RealtimeVoiceCallDeps,
} from '@ethosagent/voice-client';
