# platform-whatsapp internals

## Internals

### How pairing works

The adapter uses [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys`), the WhatsApp Web **multi-device** client. `makeWASocket` is started with `printQRInTerminal: true`; on each `connection.update` carrying a `qr`, the adapter also renders it with `qrcode-terminal` and forwards the raw string to the optional `onQr` callback — that callback is what feeds the web/desktop SSE QR surface. Credentials come from `useMultiFileAuthState(sessionDir)`, persisted via the `creds.update` event. On an unexpected disconnect (anything other than `loggedOut`) the adapter reconnects automatically after a short backoff.

### botKey derivation

```
botKey = config.id ?? `wa-<last 16 alphanumerics of session_dir>`
adapter id = `whatsapp:<botKey>`
```

`botKey` is the gateway's per-bot routing key and the name of the session directory under `~/.ethos/whatsapp/`. It must be stable across restarts — set `id` explicitly so it never depends on the session-dir path.

### Media

Inbound images and documents are downloaded with Baileys' `downloadMediaMessage` and written to the shared `AttachmentCache` (`~/.ethos/cache/attachments/`), keyed by session, so the personality's vision/document tools can read them. Files larger than **25 MB** are skipped (checked both from the declared length and the actual bytes). The adapter is inbound-media only — its `canSendFiles` capability is `false`, so the agent replies in text.

### WA Web version

Every connect asks Baileys' `fetchLatestWaWebVersion` (10 s timeout) for the current WA Web version and passes it to `makeWASocket({ version })`; when the lookup reports `isLatest: false` the socket keeps Baileys' bundled default (`resolveWaWebVersion` in `src/index.ts`). A close with status 405 is logged as a client-version rejection, not rate-limiting. Verified against the installed `@whiskeysockets/baileys@7.0.0-rc13` source on 2026-09-28 (no live test): the function's signature and return shape (`lib/Utils/generics.js`, `.d.ts`), the `version: WAVersion` socket option (`lib/Types/Socket.d.ts`), and the origin of 405 — not a `DisconnectReason` member, but the server's `failure` node `reason` (`CB:failure` in `lib/Socket/socket.js`). Pinned by `src/__tests__/wa-version.test.ts` and `src/__tests__/wa-version-real.test.ts` (which drives the real function).

### Receipt reactions

On every inbound message the adapter sets a 👀 reaction so the sender can see the agent has the message; it's cleared once the reply lands. Mirrors the Slack and Telegram adapters' receipt cue.

### Difference vs Slack — no personality `bind`

The Slack adapter binds each app to a specific personality or team via a `bind` field in its config. **WhatsApp has no `bind` field.** `WhatsAppConfig` is exactly `id`, `session_dir`, `default_mode`, and `allowed_numbers` — there is no per-bot personality binding, no `/ethos` slash commands, and no App Home tab. A WhatsApp bot serves the gateway's active personality for its lane; per-app personality binding is a Slack-only feature today, noted here as a current difference rather than a planned WhatsApp option.

---

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `WhatsAppAdapter` — Baileys socket wiring, lifecycle, inbound routing, send. |
| `src/message-parser.ts` | Raw Baileys message → `InboundMessage`; media metadata extraction. |
| `src/media.ts` | Media download + 25 MB cap + write-through to the `AttachmentCache`. |
| `src/session-store.ts` | Resolves and creates the per-bot multi-file auth-state directory. |
| `package.json` | Workspace package; deps `@whiskeysockets/baileys`, `qrcode-terminal`, `@ethosagent/types`. |
</content>
</invoke>
