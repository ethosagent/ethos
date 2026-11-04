---
title: "Start an incognito session"
description: "Start a chat Ethos does not remember or learn from, from the CLI, TUI, web app or a gateway DM, end it, and know what it still leaves behind."
kind: how-to
audience: user
slug: incognito-sessions
time: "5 min"
updated: 2026-11-04
---

## Task

Ask your agent something you do not want it to remember, in a chat that keeps nothing in long-term memory and feeds nothing into learning.

## Result

- The agent reads no `MEMORY.md`, no `USER.md`, no team memory and no other session's transcript, and writes none of them.
- Nothing from the chat feeds learning: memory capture, skill drafts, the improvement fork, `ethos evolve` export and dreams skip it. Every learner asks one question, `turnWasShared` in `packages/core/src/chat-audience.ts`, and an incognito session answers yes.
- The chat's text is blanked when you end it, and in any case 24 hours after each message.
- The agent is still a full agent: shell tools work, and spend is still billed and capped.

## Prereqs

- A working `ethos chat`. See the [quickstart](../quickstart.md) if you have none.
- For a gateway DM: a channel bot under `ethos gateway start` or `ethos boot`, and you are the configured owner of that bot.
- A [session](../../getting-started/glossary.md#session) (one conversation and its stored history) is the unit: incognito applies to one session, never to a personality or a config.

## Steps

### 1. Start an incognito session

Pick the surface you are on.

| Surface | How to start |
|---|---|
| CLI or TUI | `ethos chat --incognito`, or `/incognito` inside a running chat |
| One-shot | `ethos chat --incognito -q "<prompt>"` |
| Web app | Turn on the **Incognito** switch in the New Session picker |
| Gateway DM with the owner | Send `/incognito` |

Start from the shell:

```bash
ethos chat --incognito
```

The REPL prints one line, then a prompt prefixed with an `[incognito]` tag (the TUI shows the same tag in its status bar):

```
Incognito: nothing from this session is remembered or learned from. Cleared on /new or after 24 h.

[incognito] You >
```

Inside a running CLI or TUI chat, `/incognito` does the same as `/new` plus the flag. It starts a fresh session key, so the chat you were in is left as it was.

In a gateway DM, send `/incognito`. The bot replies:

```
Incognito on. Nothing from this chat is remembered or learned from. History is cleared when you send /new, or 24 h after each message.
```

If the DM is already incognito, the bot replies `Already incognito. Send /new to end it and clear this chat’s history.` and changes nothing.

The gateway refuses `/incognito` where memory is already withheld: in a group, in a DM the adapter marks shared, and in a DM from anyone but the owner (`Gateway.incognitoRefused` in `extensions/gateway/src/index.ts`). The reply is:

```
Incognito is only available in a private chat with the owner. This chat already keeps nothing in memory.
```

In the web app, the Composer placeholder reads `Incognito — not remembered`, the personality bar shows an `Incognito` label with an **End** button, and the session list marks the row with an eye-off icon.

### 2. Chat

Ask what you came to ask. The session is sticky: no command turns incognito off in place. `/personality` switches the persona and keeps the session incognito, because changing persona is not a request to be remembered.

### 3. End the session

| Surface | How to end |
|---|---|
| CLI, TUI, gateway DM | Send `/new` |
| Web app | Click **End** in the personality bar |
| One-shot (`-q`) | Nothing: the process scrubs the session as it exits |
| Automatic | The sweep blanks any message older than 24 hours (`INCOGNITO_MAX_AGE_MS`) |

Ending blanks the session and every session it started (delegated children, background jobs) and opens a new, normal session. In a gateway DM, `/new` replies:

```
Incognito off. That chat’s history was cleared. New session started.
```

If the blanking fails, `/new` still starts the new session and says so:

```
Incognito off. New session started. That chat’s history could not be cleared just now; it is cleared within 24 h.
```

The 24-hour sweep runs hourly in `ethos gateway start`, `ethos serve`, `ethos boot` and at `ethos chat` startup. It blanks content only. The session stays incognito with an empty history.

## Verify

1. In an incognito chat, ask "what do you remember about me?". The answer contains nothing from `MEMORY.md`.
2. Check that memory did not change. The checksum is the same before and after the chat:

   ```bash
   shasum -a 256 ~/.ethos/personalities/<personality-id>/MEMORY.md
   ```

   ```
   3f1c…  /Users/<you>/.ethos/personalities/<personality-id>/MEMORY.md
   ```

3. Send `/new`, then run `ethos usage`. The totals include the incognito turns: blanking keeps every message row and its token and cost columns.
4. In a group the bot is in, send `/incognito`. The bot sends the refusal text from step 1.

## What incognito does not cover

These are known limits, not bugs to expect fixes for in a patch release.

| Limit | What it means | Why |
|---|---|---|
| Shell tools stay on | `terminal`, `run_code`, `run_tests`, `lint` and the `process_*` tools work, and a command can read or append to `MEMORY.md` directly. | Only the owner steers the shell. `INCOGNITO_READMITTED_TOOLS` in `packages/core/src/agent-loop/audience.ts` lists exactly these, and they come back only when the caller's own audience is private. The memory boundary governs Storage, not a subprocess. |
| Plugin hooks see content | A plugin `before_prompt_build` or `agent_done` handler still receives the incognito prompt and reply. | Those payloads carry no audience field; adding one changes the plugin contract. |
| MCP servers see tool arguments | An MCP server wired to the personality can receive incognito text as tool arguments. | Ethos cannot police a separate server process. |
| Usage is kept | Spend rows stay in `ethos usage` and count toward the daily cap. Observability keeps metadata (token and cost spans, tool names) but not tool arguments or LLM payloads. | Deleting rows would hide spend. Some `grounding.finding` and `decision.tool` events can still carry text; they follow `retention.events`. |
| Free pages | Blanked text can survive in `sessions.db` free pages until a `VACUUM`. | The store does not set `PRAGMA secure_delete`. |
| Other stores | The inbound spool and the delivery ledger keep message and reply text under their own retention. The 24-hour sweep does not clear attachment caches. | The blanking covers `sessions.db` only (`SessionStore.scrubIncognito`). |
| No entry point | QuickChat, TeamChat, ACP, VS Code and voice sessions have no way to start incognito. | Not built yet. An incognito session opened elsewhere still runs incognito, but those surfaces show no indicator. |
| No restart expiry | A gateway restart does not end an incognito session. | A restart replays spooled messages. A dropped session would run your incognito message as a normal, learned-from turn. |

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `/incognito` in a group or someone else's DM gets the refusal text | That chat already keeps nothing in memory, so incognito means nothing there | Use a DM with the owner |
| `/incognito` is unknown in a platform's DM | The gateway predates the command | Upgrade, restart the gateway, retry |
| No `[incognito]` tag after `/new` | `/new` ends incognito by design | Send `/incognito` again |
| The web switch does nothing on an open session | The switch applies only when the session is created; an existing session keeps its own mode and never downgrades | Start a new chat with the switch on |
| Old incognito text still shows after `/new` | The blanking failed, or text sits in the spool or delivery ledger | Wait for the hourly sweep; see the limits table |

## See also

- [Keep memory out of group chats](./group-chat-memory.md) — the shared-room rule incognito reuses.
- [Why does private memory stay out of shared rooms?](../explanation/memory-model/shared-rooms.md) — the audience floor an incognito turn runs at.
- [Slash commands](../reference/slash-commands.md#slash-incognito) — `/incognito` and `/new` synopses.
- [CLI reference](../reference/cli.md#ethos-chat) — the `--incognito` flag.
