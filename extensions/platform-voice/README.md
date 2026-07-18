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
