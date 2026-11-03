---
title: "Add a channel adapter, part 4: session keys, streaming, voice, access"
description: "Session-key implications, streaming replies, spoken replies, access control."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 9-12 of [Add a channel adapter](add-a-channel-adapter.md): Session-key implications; Streaming reply patterns; Opt in to spoken replies; Channel filtering and access control.

## Prereqs

- Complete [part 3 of 4](add-a-channel-adapter-3-config-and-test.md).

## 9. Session-key implications

Session keys are how `AgentLoop`, the [SessionStore](../../getting-started/glossary.md#session-store), and the outbound dedup cache all agree on which conversation a message belongs to. The gateway computes the session key per-message; the adapter does not own that decision. The pattern is `${platform}:${chatId}` for most adapters, with the CLI's `pnpm dev` using `cli:<cwd-basename>` instead.

What you control in your adapter: the `chatId` you populate on `InboundMessage`. Pick a value that is stable across the conversation but distinct between conversations:

- **Telegram** uses the chat id (`ctx.chat.id`). DMs and groups get separate session keys.
- **Discord** uses the channel id. Threads under the same channel share a session unless you key on `thread_id` instead.
- **Slack** uses `channel` for channel messages and `channel + thread_ts` for thread messages.
- **Stdio** uses `stdio:${hostname}`. Every terminal session you open shares a key — fine for personal use, wrong for a multi-terminal lab.

The gateway combines `platform` + `chatId` into the canonical `sessionKey`. You do not need to handle session lifecycle in the adapter — the gateway clears dedup state on `/new` and `/personality` via `MessageDedupCache.clearSession(sessionKey)`.

## 10. Streaming reply patterns

Most adapters render the final assistant reply as one message. Platforms that support message editing (Telegram, Discord, Slack) can also stream partial replies in place: send the first `text_delta`, then `editMessage` as more deltas arrive. The pattern lives in `extensions/platform-telegram/src/index.ts` — search for `reflowChunks` for the four-line edit loop.

For the adapter author: set `canEditMessage: true`, implement `editMessage`, and the gateway will fan `text_delta` events through `editMessage` instead of buffering. The agent's final-reply text still goes through `send`; the cache deduplicates that send against the in-progress edits keyed off the same content.

The stdio adapter could stream by writing each delta to stdout directly. The cost is that the user sees the model "type", which is a nice-to-have. Adding this is a focused exercise: keep `canEditMessage: false` (because there is no editable message), but implement a `streamingSend` outbound path the gateway can route through. Two existing adapters (`platform-telegram`, `platform-slack`) are the references.

## 11. Opt in to spoken replies

Voice output is a separate, optional contract. Implement it and your adapter can speak; skip it and the gateway records a `gateway.voice_no_caps` event and delivers text only. Nothing else changes.

Two members, both from `packages/types/src/platform.ts`:

```typescript
import type {
  AdapterVoiceCaps,
  DeliveryResult,
  SendVoiceNoteOptions,
  VoiceOutboundAdapter,
} from '@ethosagent/types';

export class StdioAdapter implements PlatformAdapter, VoiceOutboundAdapter {
  readonly voiceCaps: AdapterVoiceCaps = {
    inbound: ['wav'],
    outbound: {
      formats: ['wav'],   // most preferred first
      kind: 'file',       // 'voice_note' only if the platform has a real voice bubble
      maxBytes: 8 * 1024 * 1024,
    },
  };

  async sendVoiceNote(
    chatId: string,
    audio: Uint8Array,
    opts: SendVoiceNoteOptions,
  ): Promise<DeliveryResult> {
    try {
      process.stdout.write(`[voice ${opts.filename} ${audio.length} bytes to ${chatId}]\n`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

Declared, not sniffed: the gateway calls `isVoiceOutboundAdapter(adapter)`, which requires both the method and a non-empty `outbound.formats`. It never probes for a method name — the previous `'sendVoice' in adapter` check could not tell a playable voice bubble from a plain file attachment, could not name an accepted container, and silently gave every new adapter a no-op.

Four things the gateway does with what you declared:

- **`outbound.formats`** is the transcode target list, most preferred first. The gateway converts the synthesized audio to `formats[0]` and falls back along the list. Declare only containers your platform actually plays.
- **`outbound.kind`** is honesty about rendering: `voice_note` for a playable bubble (Telegram, WhatsApp), `file` for an upload the platform gives an inline player (Slack, Discord). Do not claim a bubble you cannot draw.
- **`outbound.flags`** carries platform-specific switches — WhatsApp's `{ ptt: true }` is what turns an audio message into a push-to-talk bubble.
- **`outbound.maxBytes`** short-circuits an oversize reply with `gateway.voice_too_large` before the platform rejects it.

Two rules `sendVoiceNote` shares with `send`:

- **Never throw.** `{ ok: true }` is the delivery ledger's only proof of delivery, so a platform failure must come back as `{ ok: false, error }`. A throw is caught and folded into the same shape, but returning it yourself keeps the error message.
- **Honour `opts.threadId`.** Translate it to the platform's own thread handle (`message_thread_id`, `thread_ts`, the thread's channel id). A redelivered voice note returns to the sub-conversation it belonged to, not the root chat.

The `inbound` list is declarative only — telemetry and transcode hinting. To actually *receive* voice, classify the platform's audio uploads as `type: 'audio'` on `InboundMessage.attachments`; the gateway's `hasAudioAttachments()` gate keys on exactly that, which is why an adapter that files audio under `type: 'file'` never reaches transcription.

## 12. Channel filtering and access control

In production, you do not want anyone with the bot's token to talk to your agent. The gateway integrates a `safety-channel` package that gates inbound messages on an approval list: first message from a new sender returns a pairing-code prompt, the user pastes the code, only then does the message reach the agent. See [Deploy your first Telegram agent](../../using/tutorials/first-deploy-telegram.md#5-restrict-who-can-dm-the-bot) for the user-facing flow.

For the adapter author: nothing. The gateway runs the safety check before calling your `onMessage` handler; rejected senders never reach your code. The same is true of inbound content filters (`safety-injection`, `safety-watcher`) — they sit between the adapter and the loop.

The pattern this enforces: adapters are thin. Every cross-cutting concern (rate limiting, dedup, access control, telemetry, content filtering) lives one layer up. Adapters speak platform protocol; the gateway speaks Ethos contract.

## What you learned

- A channel adapter implements `PlatformAdapter` from `@ethosagent/types`: `id`, `displayName`, capability flags, `start`/`stop`/`send`/`onMessage`/`health`.
- Adapters do not dedupe outbound sends — the gateway's `MessageDedupCache` keyed by `(sessionId, sha256(content))` (plus the inbound message on a reply) with a 30-second TTL is the single dedup path; adapters that try to layer their own break the session-clear semantics.
- Inbound dedup uses `InboundMessage.messageId` against the gateway's `(platform, chatId, messageId)` triple; set this whenever your platform exposes a stable native id.
- `onMessage` registers a single handler — the gateway. You do not call `AgentLoop` from the adapter; the gateway owns routing, session lanes, and dispatch.
- Capability booleans (`canSendTyping`, `canEditMessage`, etc.) are advertised, not negotiated. The gateway uses them to decide which surface affordances to invoke.
- Spoken replies are an opt-in second contract: declare `voiceCaps` and implement `sendVoiceNote`, and the gateway synthesizes, transcodes to a format you declared, and tracks the send as a delivery obligation. Declare nothing and the adapter stays text-only.
- Wiring is a one-line addition in `apps/ethos/src/commands/gateway.ts` plus a path alias in the root `tsconfig.json`. The gateway iterates over `adapters: PlatformAdapter[]` and binds the same handler to each one.
- Adapters are unit-testable in isolation — stub stdin / mock the platform SDK at the boundary, assert on `onMessage` payloads and `send` outputs.
- Cross-cutting concerns (access control, dedup, telemetry, content filtering) live in the gateway and `safety-*` packages, not in your adapter. Keep adapters thin.

## Next step

You can move agents onto any platform that streams messages. The next step is making sure they ship safely.

- [Write your first tool](./write-your-first-tool.md) — the matching tutorial for the tool surface.
- [Add an LLM provider](./add-an-llm-provider.md) — the matching tutorial for the model surface.
- [Why audience boundaries?](../explanation/audience-boundary.md) — design rationale for the internal/user gate that channel adapters honour.
- [Deploy your first Telegram agent](../../using/tutorials/first-deploy-telegram.md) — the user-facing version of running an adapter under a service manager.
- [Why does a redelivered voice note re-send the recording?](../explanation/why-voice-replies-redeliver.md) — what the gateway does with the bytes your `sendVoiceNote` could not deliver.
