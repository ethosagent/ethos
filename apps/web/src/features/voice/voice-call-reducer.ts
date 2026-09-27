// Lifted to @ethosagent/voice-client (shared with the phone). Kept as a thin
// re-export so web imports do not change.
export {
  callStripVisible,
  chatMessagesWithVoice,
  initialVoiceCallState,
  isTerminalClientEvent,
  LANE_TAKEN_OVER_CODES,
  MIC_DENIED_CODE,
  markInterrupted,
  TIER_DEGRADED_CODE,
  type VoiceCallAction,
  type VoiceCallState,
  type VoiceCallStatus,
  type VoiceDegradedNotice,
  type VoiceTranscriptLine,
  voiceCallReducer,
  voiceCaption,
  voiceTranscriptToMessages,
} from '@ethosagent/voice-client';
