// Lifted to @ethosagent/voice-client (shared with the phone). Kept as a thin
// re-export so web imports do not change.
import type { VoiceCaptureIo as SharedVoiceCaptureIo } from '@ethosagent/voice-client';

export {
  createStreamingVoiceCallClient,
  type StreamingVoiceCallDeps,
} from '@ethosagent/voice-client';

/** The browser's capture hands out its `MediaStream`. */
export type VoiceCaptureIo = SharedVoiceCaptureIo<MediaStream>;
