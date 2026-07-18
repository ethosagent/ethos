# @ethosagent/platform-voice

Transport-agnostic real-time voice channel adapter. Bridges a `VoiceTransport`
to a `VoiceSession` (`@ethosagent/voice-session`), following the standard Ethos
channel-adapter contract.

Part of `plan/phases/gap-voice-realtime.md` Phase B. This package is the
**core** — the seam plus the bridge. Concrete transports (LiveKit WebRTC rooms,
Twilio Media Streams, browser mic) implement `VoiceTransport` in later, isolated
steps; nothing transport-specific lives here.

## What it does

- **`VoiceTransport`** (`transport.ts`) — the transport-agnostic seam for one
  live audio session: inbound audio frames as `PcmChunk`s (push callback), an
  outbound audio sink, a `callerId` (LiveKit participant identity / E.164
  number), and connect/disconnect lifecycle.
- **`VoiceChannelAdapter`** (`adapter.ts`) — one adapter per live call. It:
  - forwards transport inbound audio to `session.pushAudio`;
  - forwards session `reply_audio` events to the transport outbound sink;
  - stamps a stable `botKey` via `deriveBotKey` (the canonical
    `@ethosagent/core` primitive — never a local hash);
  - builds the per-caller lane key **`voice:<botKey>:<callerId>`**, so each
    caller gets their own session and, through the normal SessionStore path,
    cross-call memory;
  - exposes `lastReplyText()` (the honest played reply, with `[interrupted]` on
    barge-in) for summary/persistence hooks.

## Dedup boundary — READ THIS BEFORE "fixing" audio into the dedup path

Every outbound **channel message** flows through the gateway's single
`MessageDedupCache` (`extensions/gateway/src/dedup.ts`). Adapters do NOT roll
their own dedup.

**Audio frames are the exception, and it is deliberate:**

- **Audio frames are transport MEDIA, not channel messages.** Reply audio goes
  straight from the session's `reply_audio` event to `transport.sendAudio()` —
  it is **EXEMPT** from `MessageDedupCache`. Two synthesized frames can carry
  byte-identical audio (silence, repeated tokens); deduping them would drop real
  playout and break the conversation. Do not route audio through the dedup path.
- **Discrete artifacts DO get deduped.** Anything the adapter sends AS a channel
  message — a call summary or transcript posted to a paired text channel — goes
  through `sendArtifactMessage()` → the injected `sendArtifact` sink, which in
  production is the gateway's deduped `send()` gate. Same dedup path as every
  other adapter.

If you find yourself adding an idempotency layer inside this adapter, or piping
audio through `MessageDedupCache`, stop: that is the bug this note exists to
prevent.

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

### Why the native LiveKit deps are NOT committed

`@livekit/rtc-node` (WebRTC media) ships a **native binary**, and
`livekit-server-sdk` (JWT tokens) is its server-side companion. Neither is added
to this repo's dependency graph, deliberately:

- The native media binding cannot be verified in CI here without a running
  `livekit-server` — committing an unverifiable native dependency risks breaking
  the whole monorepo install.
- Everything in `src/livekit/` binds ONLY to the `LiveKitRoomClient` /
  `LiveKitTokenMinter` interfaces, so it typechecks and unit-tests against fakes
  (`src/livekit/__tests__/livekit-fakes.ts`). The real SDKs are a **runtime
  binding supplied at the app layer** — the app-level factory implements
  `LiveKitRoomClient` by wrapping `@livekit/rtc-node` and `LiveKitTokenMinter` by
  wrapping `livekit-server-sdk`'s `AccessToken`, then injects them into
  `createLiveKitTransport`.

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
