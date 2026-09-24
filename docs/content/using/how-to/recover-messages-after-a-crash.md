---
title: "Recover messages after a gateway crash"
description: "Check what the inbound spool replayed after a gateway crash, and replay or discard messages it gave up on with ethos gateway spool."
kind: how-to
audience: user
slug: recover-messages-after-a-crash
time: "10 min"
updated: 2026-09-24
---

## Task

Find out which channel messages a crashed [gateway](../../getting-started/glossary.md#gateway) (the process that brings Telegram, Slack, Discord, WhatsApp and Email into your agent) still owed an answer, and decide what happens to the ones it could not answer.

## Result

- Every message that arrived before the crash is answered once after restart, with no action from you — unless its turn had already started a tool, in which case the chat is asked to reply `retry`.
- Messages the gateway gave up on are listed by `ethos doctor`, and you replay or drop each one by id.
- You know which gateway process owns your Ethos home, and why a second one refuses to start.

## Prereqs

- A gateway configured and started at least once (`ethos gateway start` or `ethos boot`), so `~/.ethos/inbound-spool.db` exists.
- Shell access to the machine running it.

## Steps

### 1. Restart the gateway

The gateway writes every inbound message to the inbound spool — `~/.ethos/inbound-spool.db`, a write-ahead record of turns it owes — before any other work. A message becomes `done` only after its turn has finished and its reply has gone out, or been recorded in the delivery ledger for redelivery. After a crash, the next start replays whatever is still owed.

```bash
ethos gateway start
```

```
Inbound spool: replayed 1, 0 deferred, 0 dead-lettered
```

If you run the merged single-process profile, restart `ethos boot` instead. It opens the same spool and prints the same line once its boot reconciliation finishes.

No line means nothing was owed. The replay runs right after the adapters connect, keeps the order messages arrived in within each chat, and re-applies your channel allowlist to each one.

A turn whose reply was already recorded before the crash is not run again: its reply is redelivered from the ledger instead, so the chat gets one answer, not two.

If the crashed turn had already started a tool, it is not replayed either: re-running it could repeat a half-finished action, such as a payment or a file write. The row becomes `interrupted` and the chat gets one notice:

```
⚠ Your message was interrupted after actions had started, so it was not re-run automatically. Reply `retry` to run it again.
```

If the user replies exactly `retry` within a day, the original message runs again. Any other message in that chat drops it. A graceful stop (Ctrl+C) treats a tool-started turn the same way, and sends no "please resend" to a chat the replay will answer.

A message sent while a turn was still running is folded into that turn (the chat sees `↩ noted`), and after a crash or a stop it stays with that turn: it is replayed as part of it, or included when the user replies `retry`. It never runs as a turn of its own.

### 2. Check the gateway's state

```bash
ethos gateway status
```

```
running (pid 4242, heartbeat 4s ago)
inbound spool: 0 owed, 1 in progress, 0 dead, 0 interrupted
```

Only one gateway runs per Ethos home, and `ethos boot` counts as one. A second `ethos gateway start` or `ethos boot` exits `3` and names the running pid. If `status` says `stale lock (pid N not running)`, the next start takes the lock over — there is nothing to delete.

### 3. List messages the gateway gave up on

```bash
ethos doctor
```

```
Inbound spool
  ✓  0 owed · 0 in progress · 212 done · 2 dead · 0 interrupted
  ⚠  2 dead letter(s):
     6f1c2a3e-0b7d-4c55-9a51-1f0e8d2b7c44  telegram:81234567  attempts 3  tool exploded
     b20d9e11-5a6c-4f0e-8d3b-77aa01c2e9f5  slack:C04ABCD  attempts 0  stale
     Replay with: ethos gateway spool replay <id>   Drop with: ethos gateway spool discard <id>
```

A message lands here for one of two reasons:

| `last_error` | Why | What the user saw |
|---|---|---|
| the turn's error, attempts `3` | The turn failed on three separate attempts — including a turn that crashed the process on three boots in a row. | Nothing after the first failure. |
| `stale` | It was more than a day old when the gateway came back. | One notice per chat: "I restarted and missed N message(s) older than a day; resend if still needed." |

Doctor lists `interrupted` messages in a separate block below the dead letters. Those are waiting on the user's `retry`. Replaying one yourself re-runs the turn, tools included.

The same list is on the web dashboard: Settings → Voice → **inbound — dead**, with Replay and Discard buttons. Its State column shows `dead` or `interrupted — awaiting retry`.

### 4. Replay or discard each one

If the cause is fixed — a tool repaired, a provider back up — replay it:

```bash
ethos gateway spool replay 6f1c2a3e-0b7d-4c55-9a51-1f0e8d2b7c44
```

```
Requeued 6f1c2a3e-0b7d-4c55-9a51-1f0e8d2b7c44. A running gateway replays it within a minute; otherwise on its next start.
```

If the message should not be answered any more, drop it:

```bash
ethos gateway spool discard b20d9e11-5a6c-4f0e-8d3b-77aa01c2e9f5
```

```
Discarded b20d9e11-5a6c-4f0e-8d3b-77aa01c2e9f5.
```

### 5. Tune the limits (optional)

Two keys in `~/.ethos/config.yaml` change when a message is given up on:

| Key | Default | Range | Effect |
|---|---|---|---|
| `gateway.inboundSpool.maxAttempts` | `3` | 1–100 | Failed attempts before a message is dead-lettered. |
| `gateway.inboundSpool.maxReplayAgeMs` | `86400000` (24 h) | 60000–2592000000 | Older owed messages are dead-lettered as `stale` at replay instead of answered. |

```yaml
gateway.inboundSpool.maxAttempts: 5
gateway.inboundSpool.maxReplayAgeMs: 43200000
```

Restart the gateway to apply them.

## Verify

Stop the gateway gracefully while it is answering (Ctrl+C), then start it again. The interrupted message is answered once, and `ethos gateway status --json` shows `"spool":{"received":0,…}` once the replay finishes. A graceful stop does not count against `maxAttempts`; a `kill -9` does.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `ethos gateway start` or `ethos boot` exits `3` | Another gateway — a `gateway start` or a `boot` — owns this Ethos home. | Run `ethos gateway status`. Stop the running one, or leave it — `ethos run-all` and the desktop app attach to it instead of starting a second. |
| Doctor reports owed messages "for a bot no longer configured" | The bot was removed from `config.yaml` with messages still owed. | Re-add the bot and restart; the replay delivers them. They are never dead-lettered automatically. |
| A replayed message arrived without its image | The cached attachment file was gone at replay time. | Nothing to fix; the text still ran, ending with `[attachment could not be recovered]` so the agent knows. Ask the sender to resend the image. |
| The same message was answered twice | Telegram's chunked send reports success for a partly delivered long reply, and delivery is at-least-once by design. | Expected for long replies after a crash mid-send. |

Retention: `done` rows are kept 7 days with the message body removed at completion, dead rows 30 days, owed rows until answered. `ethos retention show` lists this. The spool is excluded from `ethos backup` — replaying it on another machine would answer old messages there.
