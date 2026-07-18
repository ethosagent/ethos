// SipTrunkClient — the isolated boundary that keeps the concrete LiveKit SIP
// SDK out of this repo's dependency graph (telephony half of Phase C,
// plan/phases/gap-voice-realtime.md §4).
//
// A SIP phone call is just another LiveKit participant: a rented PSTN number +
// SIP trunk (Twilio/Telnyx/…) is pointed at LiveKit SIP, which bridges the call
// into a LiveKit room. Once bridged, the EXISTING LiveKitVoiceTransport ->
// VoiceChannelAdapter -> VoiceSession stack (Phase B) handles the audio — this
// layer only adds trunk/dispatch (inbound number -> room/identity) and the
// outbound `createOutboundCall`.
//
// The production binding wraps `livekit-server-sdk`'s SIP API (`SipClient`:
// `createSIPParticipant` for outbound, inbound-trunk/dispatch-rule config for
// inbound). That package is NOT installed in-repo (same rationale as
// `@livekit/rtc-node` in room-client.ts — an unverifiable server binding); code
// here binds ONLY to the interface below, so it typechecks and unit-tests
// against a `FakeSipTrunkClient`. Wiring the real SDK is a documented MANUAL
// step (see README.md "Telephony (SIP) manual verification checklist").

/** Request to place an outbound PSTN call and bridge it into a LiveKit room. */
export interface OutboundCallRequest {
  /** E.164 destination number to dial. */
  toNumber: string;
  /** LiveKit room the bridged call is placed into (the agent joins the same
   *  room via {@link import('../livekit/transport').LiveKitVoiceTransport}). */
  roomName: string;
  /** Caller-ID number presented to the callee (E.164). Optional — defaults to
   *  the trunk's configured `fromNumber`. */
  fromNumber?: string;
  /** Identity the SIP participant joins the room AS. Defaults to `toNumber`. */
  participantIdentity?: string;
}

/** Handle for a placed outbound call. */
export interface OutboundCallHandle {
  /** Provider/LiveKit call (SIP participant) id. */
  callId: string;
  /** Room the call was bridged into. */
  roomName: string;
  /** The dialed E.164 number. */
  toNumber: string;
}

/**
 * An inbound SIP call as reported by the trunk once LiveKit SIP has placed the
 * caller into a room. `fromNumber` (the caller) becomes the `callerId` /
 * lane-key seed so a repeat caller reuses their session — per-caller cross-call
 * memory (plan §3(b)); `toNumber` (the dialed DID) selects the bound bot.
 */
export interface InboundSipCall {
  /** E.164 number of the caller (the remote party). */
  fromNumber: string;
  /** Dialed DID — matched against `voice.bots[]` to pick the personality. */
  toNumber: string;
  /** LiveKit room the SIP call was bridged into. */
  roomName: string;
}

/**
 * Minimal SIP trunk client — ONLY the surface Phase C uses. The production
 * binding wraps `livekit-server-sdk`'s SIP API; inbound calls are surfaced by
 * the app-layer wiring (a webhook / dispatch-rule callback delivering an
 * {@link InboundSipCall}), not modeled as a method here.
 */
export interface SipTrunkClient {
  /** Place an outbound call and bridge it into `roomName`. */
  createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallHandle>;
}
