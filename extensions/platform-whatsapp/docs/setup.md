# platform-whatsapp setup

WhatsApp `PlatformAdapter` for Ethos — links to a real WhatsApp account as a device (via the WhatsApp Web multi-device protocol) so your bot serves chats with no tokens, no Business API, and no public URL or webhook.

This README walks an operator from zero to a working bot in a few minutes — pair by scanning a QR code — then documents reply modes, sender allowlisting, and troubleshooting. Contributors looking for the architectural picture jump to [Internals](internals.md).

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

# REQUIRED — channel-filter safety gate. Without it the gateway refuses to boot.
channel_filter.whatsapp.ownerUserId: 14155551234@s.whatsapp.net   # your WhatsApp JID (E.164 number + @s.whatsapp.net)
```

The `whatsapp.*` keys are the adapter config — `id`, `default_mode`, `allowed_numbers`, `session_dir`; there are no tokens or webhook URLs. The `channel_filter.whatsapp.ownerUserId` line is **required**: `ethos gateway start` fails closed with `FATAL: Channel adapters configured without channel_filter safety config` if it's missing. It scopes who the bot accepts messages from (set it to your own WhatsApp number's JID).

> **Prefer the app? Enable from the desktop or web UI instead.** Open the web **Communications → WhatsApp** panel (or the desktop **WhatsApp** drawer), enter a bot name, reply mode, and your owner number, and click **Enable** — it writes the `whatsapp.*` and `channel_filter.whatsapp.ownerUserId` config for you (Steps 1). Then restart the gateway: on **desktop** click **Restart gateway** in the drawer and the QR appears there; on **web**, restart the gateway (or re-run `ethos serve`) and scan from the Communications page. Steps 2-4 below describe the equivalent CLI path.

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

If you don't see a reply, jump to [Troubleshooting](operations.md#troubleshooting).

---

