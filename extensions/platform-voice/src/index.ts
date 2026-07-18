// @ethosagent/platform-voice — transport-agnostic real-time voice channel
// adapter. Bridges a VoiceTransport (LiveKit, Twilio, browser mic — concrete
// transports land in later steps) to a VoiceSession from
// @ethosagent/voice-session.

export {
  type VoiceArtifact,
  type VoiceBotIdentity,
  VoiceChannelAdapter,
  type VoiceChannelAdapterDeps,
} from './adapter';
export type { OutboundAudioFrame, VoiceTransport } from './transport';
