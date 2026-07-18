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
export type {
  LiveKitAudioFrame,
  LiveKitConnectOptions,
  LiveKitRoomClient,
  LiveKitTokenMinter,
} from './livekit/room-client';
export {
  createLiveKitTransport,
  type LiveKitRoomBinding,
  type LiveKitTransportFactoryDeps,
  LiveKitVoiceTransport,
  type LiveKitVoiceTransportConfig,
  type LiveKitVoiceTransportDeps,
  resamplePcm,
} from './livekit/transport';
export type { OutboundAudioFrame, VoiceTransport } from './transport';
