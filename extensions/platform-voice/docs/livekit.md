# LiveKit transport

## LiveKit transport (`src/livekit/`)

The concrete LiveKit transport lives in `src/livekit/`:

- **`room-client.ts`** — `LiveKitRoomClient` + `LiveKitTokenMinter`: the isolated
  boundary interfaces capturing ONLY what the transport uses (connect,
  disconnect, subscribe to remote audio, publish local audio, participant
  identity; and JWT minting).
- **`transport.ts`** — `LiveKitVoiceTransport` implements `VoiceTransport`
  against that boundary. It resamples inbound LiveKit frames (48kHz →
  16kHz decimation, `resamplePcm`), converts our `OutboundAudioFrame` PCM back
  to LiveKit samples, and mints an access token on `connect()`. `callerId` is
  the LiveKit participant identity. `createLiveKitTransport(deps)` is the wiring
  seam — given a room-client factory + token minter + a per-caller
  `VoiceSession` factory, it composes transport → adapter → `VoiceSession` per
  participant.

- **`token.ts`** — `createLiveKitTokenMinter` / `createLiveKitSipJwt`: the real
  token minter, an HS256 JWT signed with `node:crypto` and **no dependency**.
  This is what finally makes `voice.livekit.apiKey` / `apiSecret` reachable —
  before V4 they were parsed by `@ethosagent/config` and read by nothing.

### Why the native media dep is NOT committed (and why the control plane needs none)

The line is MEDIA vs CONTROL:

- **Media needs a native binding.** `@livekit/rtc-node` (WebRTC) ships a native
  binary that cannot be verified in CI here without a running `livekit-server` —
  committing an unverifiable native dependency risks breaking the whole monorepo
  install. `src/livekit/transport.ts` binds ONLY to the `LiveKitRoomClient`
  interface, so it typechecks and unit-tests against fakes
  (`src/livekit/__tests__/livekit-fakes.ts`); the app layer implements the
  interface by wrapping the SDK and injects it into `createLiveKitTransport`.
- **Control needs no SDK at all.** A LiveKit access token is an HS256 JWT, and
  the SIP API is a JSON POST authorized by one. `livekit-server-sdk` would
  contribute a signer and a request builder, so V4 writes them here instead:
  `src/livekit/token.ts` mints tokens and `src/sip/trunk-client-livekit.ts`
  places real outbound calls, both over `node:crypto` + global `fetch`, both
  fully unit-tested. `LiveKitTokenMinter` remains an interface so a deployment
  can substitute an external signing service.

### Manual verification checklist (real bindings + running server)

This is the manual step that exercises the native path end to end. It is NOT run
in CI.

1. **Install the native deps at the app layer** (not in this package):
   `pnpm add @livekit/rtc-node livekit-server-sdk`.
2. **Run a local LiveKit server** via docker:
   `docker run --rm -p 7880:7880 -p 7881:7881 -e LIVEKIT_KEYS="devkey: devsecret" livekit/livekit-server --dev`.
3. **Configure** `~/.ethos/config.yaml`:
   ```
   voice.livekit.url: ws://localhost:7880
   voice.livekit.apiKey: devkey
   voice.livekit.apiSecret: devsecret
   voice.bots.0.match: room-*
   voice.bots.0.bind.type: personality
   voice.bots.0.bind.name: <a voice-capable personality>
   ```
4. **Implement the app-layer factory**: a `LiveKitRoomClient` wrapping
   `@livekit/rtc-node` (subscribe to the remote track's `AudioStream`, publish an
   `AudioSource`/`LocalAudioTrack`) and a `LiveKitTokenMinter` wrapping
   `AccessToken` (grant `roomJoin` for the room). Inject both into
   `createLiveKitTransport`.
5. **Mint a token** for a browser/second client and **connect** it to the same
   room (LiveKit Agents playground or a minimal web client).
6. **Speak** and confirm the agent replies with audio; **assert p50
   utterance-end → first-audio ≤ 2.5s** (plan §3(c) budget) using
   `scripts/voice-latency-bench.ts` per-stage timings.
7. **Barge-in**: speak over the reply and confirm playout stops within ~300ms and
   history records `[interrupted]`.

