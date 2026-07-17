---
title: "Channel capability matrix"
description: "What each Ethos channel adapter supports: typing, streaming edits, media, threads, reactions, and how the gateway degrades when a capability is absent."
kind: reference
audience: shared
slug: channel-capability-matrix
updated: 2026-07-17
---

Not every channel supports every feature. Telegram edits messages in place; email cannot. Slack uploads files; WhatsApp does not. The gateway reads each adapter's declared capabilities and degrades gracefully — a streamed reply falls back to a single message where edits are unavailable, and outbound media falls back to text where uploads are unsupported. This page is the authoritative lookup for what each adapter supports today.

Each capability is declared on the adapter itself (the `canSendTyping` / `canEditMessage` / `canReact` / `canSendFiles` flags and the `capabilities` manifest), so this table tracks source, not aspiration.

## Support matrix {#matrix}

| Capability | Telegram | Slack | Discord | WhatsApp | Email |
|---|---|---|---|---|---|
| Typing indicator | ✓ | ✓ (probed) | ✓ | ✗ | ✗ |
| Streaming draft edits | ✓ | ✓ | ✓ | ✗ | ✗ |
| Message edit (`editMessage`) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Inbound media | ✓ | ✓ | ✗ | ✓ | ✗ |
| Outbound media | ✓ | ✓ | ✗ | ✗ | ✗ |
| Reactions | ✓ | ✓ | ✓ | ✓ | ✗ |
| Threads / topics | ✓ (forum topics) | ✓ (`thread_ts`) | ✓ | ✗ | ✗ |
| Reply-to a message | ✓ | ✗ | ✗ | ✓ | ✗ |
| Approval buttons | ✓ | ✓ | ✓ | ✗ | ✗ |
| Slash commands | ✓ | ✓ | ✓ | ✗ | ✗ |
| Voice out (TTS) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Webhook mode | ✓ | ✗ | ✗ | ✗ | ✗ |
| Max message length | 4096 | 3000 | 2000 | 65536 | 100000 |

`✓ (probed)` — Slack's typing indicator uses an unofficial API; the adapter probes it once at runtime and reports the real result thereafter, so `canSendTyping` reflects what actually works on the workspace.

## How degradation works {#degradation}

The gateway never assumes a capability. Two behaviors depend directly on this matrix:

- **Streaming draft edits (W3.1).** When a chat is streaming-enabled and the adapter reports `canEditMessage`, the gateway delivers the reply as throttled `editMessage` updates that grow in place. When the adapter cannot edit (WhatsApp, Email), the reply is delivered as a single final message instead. Streaming defaults on for direct messages and off for group chats; set `display.streaming_edits` in `~/.ethos/config.yaml` to `off`, `dms`, or `all`.
- **Outbound media (W3.2).** When a tool produces media and the adapter reports `canSendFiles` (Telegram, Slack), the gateway maps it to native attachments (`sendPhoto` / `sendDocument` on Telegram, `files.uploadV2` on Slack). When the adapter cannot send files, the reply degrades to the text summary — no error, no dropped turn.

## Source {#source}

Each adapter declares its capabilities in source. Consult the adapter for the exact runtime behavior:

| Platform | Adapter |
|---|---|
| Telegram | [extensions/platform-telegram/src/index.ts](../../../extensions/platform-telegram/src/index.ts) |
| Slack | [extensions/platform-slack/src/adapter.ts](../../../extensions/platform-slack/src/adapter.ts) |
| Discord | [extensions/platform-discord/src/index.ts](../../../extensions/platform-discord/src/index.ts) |
| WhatsApp | [extensions/platform-whatsapp/src/index.ts](../../../extensions/platform-whatsapp/src/index.ts) |
| Email | [extensions/platform-email/src/index.ts](../../../extensions/platform-email/src/index.ts) |

The capability contract itself — `ChannelCapabilities` and the legacy `AdapterCapabilities` — lives in [packages/types/src/platform.ts](../../../packages/types/src/platform.ts).

## See also {#see-also}

- [Telegram platform](telegram.md)
- [Slack platform](slack.md)
- [Discord platform](discord.md)
