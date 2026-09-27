// Lifted to @ethosagent/voice-client (shared with the phone). Kept as a thin
// re-export so web imports do not change.
export {
  createVoiceSocketTransport,
  VOICE_RECONNECT_BACKOFF_MS,
  type VoiceSocketLike,
  type VoiceSocketTransportOptions,
  type VoiceTransport,
  type VoiceTransportStatus,
  voiceSocketUrl,
} from '@ethosagent/voice-client';
