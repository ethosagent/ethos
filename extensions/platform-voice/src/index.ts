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
export {
  createInboundDispatcher,
  type InboundDispatchDeps,
  matchesVoicePattern,
  resolveVoiceBot,
} from './sip/inbound-dispatch';
export { createPostCallSummary, type PostCallSummaryDeps } from './sip/post-call-summary';
export type {
  InboundSipCall,
  OutboundCallHandle,
  OutboundCallRequest,
  SipTrunkClient,
} from './sip/trunk-client';
export type { OutboundAudioFrame, VoiceTransport } from './transport';
