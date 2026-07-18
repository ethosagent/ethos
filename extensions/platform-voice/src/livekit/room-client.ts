// LiveKitRoomClient / LiveKitTokenMinter — the isolated boundary that keeps the
// concrete LiveKit SDKs out of this repo's dependency graph.
//
// The production binding wraps two native npm packages:
//   - `@livekit/rtc-node`     — WebRTC media: room connect, track subscribe /
//                               publish, and PCM `AudioFrame`s.
//   - `livekit-server-sdk`    — signs JWT access tokens (`AccessToken`).
// NEITHER is installed in-repo: `@livekit/rtc-node` ships a native binary that
// cannot be verified here without a running `livekit-server`, so committing it
// would put an unverifiable dependency in the monorepo. Instead the transport
// (`transport.ts`) binds ONLY to the two interfaces below, so everything
// typechecks and unit-tests against fakes; wiring the real SDKs is a documented
// MANUAL step (see README.md "Manual verification checklist").

/**
 * One frame of linear PCM audio as delivered by / handed to the LiveKit media
 * SDK. `samples` are interleaved signed 16-bit mono samples at `sampleRate`.
 * Mirrors the shape of `@livekit/rtc-node`'s `AudioFrame` (`data`,
 * `sampleRate`), narrowed to the fields the transport uses.
 */
export interface LiveKitAudioFrame {
  samples: Int16Array;
  sampleRate: number;
}

/** Options for joining a LiveKit room as the agent participant. */
export interface LiveKitConnectOptions {
  /** LiveKit server / room URL (e.g. `wss://…`). */
  url: string;
  /** Signed access token authorizing the join (from a {@link LiveKitTokenMinter}). */
  token: string;
  /** The identity the client connects to the room AS (the agent/bot side). */
  identity: string;
}

/**
 * Minimal LiveKit room client — ONLY the surface {@link
 * import('./transport').LiveKitVoiceTransport} uses. One client = one room join
 * for one live session.
 */
export interface LiveKitRoomClient {
  /** Join the room. Resolves once media can flow. */
  connect(opts: LiveKitConnectOptions): Promise<void>;
  /** Leave the room and release media resources. */
  disconnect(): Promise<void>;
  /**
   * Subscribe to the remote participant's audio track. The handler receives
   * one {@link LiveKitAudioFrame} per delivered media frame. Returns an
   * unsubscribe function.
   */
  onRemoteAudio(handler: (frame: LiveKitAudioFrame) => void): () => void;
  /** Publish one frame of local audio to the room (the outbound track sink). */
  publishAudio(frame: LiveKitAudioFrame): void;
  /**
   * The remote participant's identity (the callerId). Available once a remote
   * participant is present; used by the wiring seam to spin up a per-caller
   * session.
   */
  remoteIdentity(): string;
}

/**
 * Mints a LiveKit access token (JWT). The production binding wraps
 * `livekit-server-sdk`'s `AccessToken`, signing with the project
 * apiKey/apiSecret (`voice.livekit.*` in `@ethosagent/config`). Behind the
 * boundary so JWT minting never pulls the server SDK into a unit test.
 */
export interface LiveKitTokenMinter {
  mint(roomName: string, identity: string): string;
}
