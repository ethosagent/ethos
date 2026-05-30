# @ethosagent/platform-whatsapp

WhatsApp `PlatformAdapter` for Ethos — links to a real WhatsApp account as a device (via the WhatsApp Web multi-device protocol) so your bot serves chats with no tokens, no Business API, and no public URL or webhook.

This README walks an operator from zero to a working bot in a few minutes — pair by scanning a QR code — then documents reply modes, sender allowlisting, and troubleshooting. Contributors looking for the architectural picture jump to [Internals](#internals).

> **Responsible use.** This adapter pairs through the **unofficial** WhatsApp Web protocol (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and links as a device on a real WhatsApp account — it is **not** the official WhatsApp Business API. Aggressive or heavily automated use can get a number flagged or banned by WhatsApp. Use a number you control and expect to keep, keep volume reasonable, and don't run it against numbers you don't own.

---

## What you can do

- **Chat with your Ethos personality from WhatsApp** — DM the bot or address it in a group; the personality answers with its configured prompt, tools, and memory.
- **Pair with a QR scan, no secrets to copy** — there are no tokens or webhooks. You scan a QR code once with your phone's WhatsApp and the device link persists across restarts.
- **Run multiple bots** — declare more than one WhatsApp config, each with its own session and routing lane.
- **Tune group chattiness** — set a bot to `mention_only` (reply only when addressed) or `all` (reply to every group message). DMs always get a reply.
- **Allowlist senders** — restrict who the bot will answer by phone number / JID.
- **Send pictures and files to the agent** — inbound WhatsApp media is downloaded and cached so the personality's vision/document tools can read it.

---

## Quickstart — pair in a few minutes

You'll add a WhatsApp entry to Ethos, start the gateway, scan a QR code with your phone, and say hello.

### Prereqs

- `@ethosagent/cli` installed and `ethos setup` has been run (so you have a `~/.ethos/config.yaml` and at least one personality).
- A phone with WhatsApp installed and signed in — the number this bot will run as.
- A few minutes.

### Step 1 · Add the bot to `~/.ethos/config.yaml`

WhatsApp bots live in a `whatsapp` array. Each entry gets an index `<n>` (any non-negative integer). Every field is optional:

```yaml
whatsapp.0.id: my-wa-bot                    # stable identifier; recommended (required for multiple bots)
whatsapp.0.default_mode: mention_only       # or 'all' — group reply behaviour; default is 'mention_only'
whatsapp.0.allowed_numbers:                 # optional allowlist of JIDs / numbers
  - "14155551234@s.whatsapp.net"
# whatsapp.0.session_dir: ~/.ethos/whatsapp # optional; default is ~/.ethos/whatsapp
```

That's the complete field list — `id`, `default_mode`, `allowed_numbers`, and `session_dir`. There are no tokens, signing secrets, or webhook URLs to configure.

### Step 2 · Start the gateway

```bash
ethos gateway start
```

### Step 3 · Scan the QR code

On first run the adapter prints a **QR code in your terminal**. On your phone:

1. Open **WhatsApp → Settings → Linked Devices → Link a Device**.
2. Point the camera at the terminal QR code.

The device links, the QR disappears, and the bot is online. Baileys' multi-file auth state is saved under `~/.ethos/whatsapp/<botKey>/`, so you **don't re-scan on restart** — the link persists until you log out or delete the session directory.

> **Pair from the dashboard instead.** If you run the web or desktop app, you can scan from there rather than the terminal. The app streams the live QR over SSE at `GET /setup/whatsapp/:botId` (the web **Communications** page and the desktop **WhatsApp** drawer both consume it), and a `{ paired: true }` event fires once the link completes.

### Step 4 · Say hello

DM the bot's number from another WhatsApp account, or address it in a group it's in. You should see a reply within a few seconds, in the personality's voice.

If you don't see a reply, jump to [Troubleshooting](#troubleshooting).

---

## Reply modes

`default_mode` controls how a bot behaves in **groups**. There are two modes; the default is `mention_only`.

| Mode | The bot replies when… |
|---|---|
| `mention_only` *(default)* | In a group: only when a message addresses the bot (`@`-mentions its number). Silent otherwise. |
| `all` | In a group: every message. Use for a dedicated group; the bot will respond to noise too. |

**DMs ignore the mode** — there's no useful semantic for "only `@mention` me in a direct message," so the bot always replies in a one-on-one chat regardless of `default_mode`.

**Cost note for `all` mode.** A bot in `all` mode on a busy group responds to every message, including ones that probably weren't meant for it. The adapter doesn't enforce rate limits — and remember the responsible-use note at the top about keeping volume reasonable.

---

## Allowlisting senders

`allowed_numbers` restricts which senders the bot will answer. It's a list of JIDs / phone numbers:

```yaml
whatsapp.0.allowed_numbers:
  - "14155551234@s.whatsapp.net"
  - "447700900123@s.whatsapp.net"
```

- Matching is by **digits only** — the adapter strips everything but the numbers from both the configured entry and the sender, so `14155551234@s.whatsapp.net` and `+1 (415) 555-1234` compare equal.
- In a **group**, the check is against the *sending participant's* number, not the group.
- **Omitted or empty** = no allowlist filter; everyone is allowed (still subject to the reply mode).

The allowlist is a hard gate: a sender not on the list is dropped before the mode is even considered.

---

## Running multiple bots

Declare more than one entry under `whatsapp.<n>`:

```yaml
whatsapp.0.id: support-bot
whatsapp.0.default_mode: mention_only

whatsapp.1.id: ops-bot
whatsapp.1.default_mode: all
```

- **A unique `id` is required when you run more than one bot.** The gateway refuses to start if any of multiple configs is missing an `id`, or if two share the same one.
- Each bot routes on its own lane (`whatsapp:<botKey>:<chat>`) and keeps its own session directory, so conversations never cross bots.
- `botKey` is the config `id` when set; otherwise the adapter derives `wa-<sanitized tail of session_dir>`. Setting `id` gives you a stable, log-friendly key — strongly recommended.

Each WhatsApp account can only be linked to one running bot at a time — a separate bot needs a separate phone number and its own scan.

---

## Adapter-owned state

The link is stored as Baileys multi-file auth state under:

```
~/.ethos/whatsapp/<botKey>/
```

(`<botKey>` is your config `id`, sanitized.) This directory holds the credentials and pre-keys that keep the device paired — it's why you only scan once.

- **To unlink / re-pair:** stop the gateway, delete `~/.ethos/whatsapp/<botKey>/`, and restart. The adapter prints a fresh QR code; scan it again. (It's also good hygiene to remove the stale link from your phone under **Linked Devices**.)
- **To move a bot to a new machine:** copy its `<botKey>` directory across, or just delete it and re-scan on the new host.

---

## Troubleshooting

If something looks wrong after Step 4, work top-to-bottom — earlier rows block later ones.

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos gateway start` exits with a WhatsApp id error | Multiple `whatsapp.<n>` configs with a missing or duplicate `id` | Give every WhatsApp entry a unique `id` |
| No QR code appears in the terminal | The bot is already paired (auth state exists), or the gateway didn't reach the WhatsApp adapter | If you expect a fresh pair, delete `~/.ethos/whatsapp/<botKey>/` and restart; otherwise the bot is likely already linked and online |
| QR appears but pairing never completes | The phone scan timed out or the QR rotated before you scanned | QR codes rotate; scan promptly. Re-run `ethos gateway start` to get a fresh code, or scan from the dashboard QR |
| Bot was working, now silent and logs show it logged out | WhatsApp invalidated the device link (logged out from the phone, or flagged) | Delete `~/.ethos/whatsapp/<botKey>/` and re-pair by scanning a new QR |
| Bot never replies in a group | Mode is `mention_only` (default) and the message didn't address the bot | `@`-mention the bot in the group, DM it instead, or set `whatsapp.<n>.default_mode: all` |
| Bot ignores a specific sender | `allowed_numbers` is set and that sender isn't on it | Add the sender's number/JID to `allowed_numbers`, or remove the allowlist to answer everyone |

---

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
