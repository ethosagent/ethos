# Dedup boundary

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

