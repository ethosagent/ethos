# platform-whatsapp behaviour and operations

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
| Log says `WhatsApp rejected the client version (405)` and no QR appears | WhatsApp retired the WA Web version the socket advertised; the version lookup at connect failed, so Baileys' bundled default was used | Let the host reach `https://web.whatsapp.com/sw.js` and restart, or upgrade `@whiskeysockets/baileys` |

---

