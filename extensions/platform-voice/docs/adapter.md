# platform-voice adapter and transport seam

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

