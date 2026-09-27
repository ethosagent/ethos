// Lifted to @ethosagent/voice-client (shared with the phone). Kept as a thin
// re-export so web imports do not change.
import type { VoiceCallClient as SharedVoiceCallClient } from '@ethosagent/voice-client';

export {
  createUnwiredVoiceCallClient,
  parseVoiceCallControlEvent,
  type VoiceCallAudioFormat,
  type VoiceCallEvent,
} from '@ethosagent/voice-client';

/** In the browser the mic handle is a `MediaStream`. */
export type VoiceCallClient = SharedVoiceCallClient<MediaStream>;
