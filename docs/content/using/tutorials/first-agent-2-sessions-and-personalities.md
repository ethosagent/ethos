---
title: "Build your first agent, part 2: sessions, personalities, verbose, one-shot"
description: "Resume a session, switch personality, read verbose output, use one-shot mode."
kind: tutorial
audience: user
updated: 2026-11-03
---

## Goal

Finish steps 5-10 of [Build your first agent](first-agent.md): Exit, reopen, and prove the session survives; Switch personality and watch the same prompt behave differently; List every personality you can switch to; Verbose mode — read what the framework just did; Interrupt a turn cleanly; One-shot mode for scripts.

## Prereqs

- Complete [part 1 of 2](first-agent.md).

## 5. Exit, reopen, and prove the session survives

Sessions live in SQLite at `~/.ethos/sessions.db` (WAL mode, FTS5-indexed). They are not stored in process memory. Prove it by closing chat and reopening.

```
/exit
```

The shell returns. Now reopen from the same directory:

```bash
ethos chat
```

The header prints the same personality and model. Send one message that references prior turns:

```
You > what was the last thing we discussed?
```

The agent answers using the recent history — the session store returned the newest messages in chronological order and the LLM saw them as context. `getMessages(sessionId, { limit })` deliberately returns the tail of the conversation, not the head; long-running sessions favour recent context over old.

A few session conventions worth knowing now:

- The session key is `cli:<cwd-basename>`. `cd` to a different directory and you get a different session. The agent does not see across directories unless you copy memory explicitly.
- `/new` starts a fresh session in the same directory by appending `:<timestamp>` to the key. The old session stays on disk, just out of reach for this conversation. The outbound-dedup cache is keyed by the old session id, so `/new` releases any prior dedup blocks — the same response text can be sent again under the fresh key.
- `/memory` prints the active personality's `MEMORY.md` and `USER.md` — `~/.ethos/personalities/<id>/` under the default markdown backend — when they are non-empty. Memory is rolling context across sessions; sessions are the per-conversation log. Memory and sessions are different layers — do not confuse them.
- Sessions are pruned by the retention TTLs in [`config.yaml`](../reference/config-yaml.md). The default `retention.messages: 365d` keeps a year of history; tighten it if disk grows or loosen it if you want forever.
- The session store is FTS5-indexed. The `session_search` tool (in the researcher's and reviewer's toolsets) can grep across prior sessions for relevant context — handy when you remember solving something in a different working directory.

Try one now:

```
/new
You > do you remember what we just discussed?
```

The agent says no — the new session started clean. Type `/exit` when you are done; the previous session is still there if you want to come back to it through SQLite tooling.

## 6. Switch personality and watch the same prompt behave differently

Open chat again. Send a write-shaped prompt to the researcher:

```bash
ethos chat
```

```
You > write a one-line shell command that lists the largest files in the current directory.
```

Researcher answers in prose with the command embedded. It does not run the command — its `toolset.yaml` does not include `terminal`. The reply is a recommendation, not an execution.

Switch to engineer mid-session:

```
/personality engineer
```

The chip in the header updates from `Researcher` to `Engineer`. Send the same prompt:

```
You > write a one-line shell command that lists the largest files in the current directory.
```

Engineer answers with the command first, terse explanation second. Its toolset includes `terminal`, so if you ask it to run the command — `now run it` — engineer will offer to execute. Researcher would not.

What changed in one slash command:

- **System prompt** — swapped from `researcher`'s `SOUL.md` to `engineer`'s.
- **Tool catalog** — `terminal`, `write_file`, `patch_file`, `run_tests` came into scope; the LLM now sees them. `web_search` and `web_extract` left scope.
- **Model** — both run on the model you configured. Each declares per-role models in `config.yaml` (researcher `claude-opus-4-7`, engineer `claude-sonnet-4-6`), but with no model registry configured a turn does not read a personality's `model` at all (`resolveTurnModel` (`packages/core/src/agent-loop/turn-model.ts`)); `modelRouting.<id>` in `~/.ethos/config.yaml` is how you give one personality a different model.
- **Memory scope** — each personality reads and writes its own `MEMORY.md` (scope `personality:<id>`), so the engineer does not see what the researcher noted. No setting shares it; memory that has to cross personalities goes in team memory.

That atomic four-dimensional swap is the headline claim of Ethos. The personality is the unit of architecture; the LLM is the substrate. The [What is a personality?](../explanation/what-is-a-personality.md) page argues for the design choice; the [Personality config reference](../reference/personality-yaml.md) lists every field.

## 7. List every personality you can switch to

```
/personality list
```

Output:

```
Built-ins: researcher · engineer · reviewer
User personalities: ~/.ethos/personalities/<id>/
```

The three built-ins ship with the CLI inside `extensions/personalities/data/`. The user directory is empty until you write one — the next tutorial does exactly that. Switch back to researcher when you are done:

```
/personality researcher
```

To see the full description of each built-in from outside chat:

```bash
ethos personality list
```

This prints id, description, and the default marker. The default at install time is `researcher`; change it with `ethos personality set <id>` or by editing `personality:` in `~/.ethos/config.yaml`.

## 8. Verbose mode — read what the framework just did

Send any message, then toggle verbose timing:

```
/verbose
You > one more turn
```

The next reply ends with a one-line summary:

```
ttft 612ms · llm 1.2s · tools 412ms · total 2.4s · 184/96 tokens · $0.00214
```

What the numbers mean:

- `ttft` — time to first text delta. Bigger than expected? The model is thinking. Bigger than 5s consistently? Provider is slow.
- `llm` — wall-clock time inside the LLM call. Sum of all chunks until the LLM said done.
- `tools` — wall-clock time spent inside tool executions in this turn. Parallel tool calls overlap, so this is the elapsed time, not the cumulative CPU time.
- `total` — wall-clock for the whole turn from input to `done` event.
- `tokens` — input / output for this turn only (not cumulative). `/usage` is cumulative.
- cost — provider rate applied to those tokens.

The summary is per-turn, not per-session. To make verbose mode the default, set `verbose: true` in `~/.ethos/config.yaml` or pass `--verbose` to `ethos chat`. Toggle inside the session with `/verbose` to swap the flag on the fly. Useful for debugging slow turns or unexpected cost spikes.

## 9. Interrupt a turn cleanly

Sometimes the agent goes off on a tangent and you want to stop it before it costs more tokens. Press `Ctrl+C` once while the turn is running:

```
You > do a long meandering analysis of every postgres major version since 9
^C
[aborted — press Ctrl+C again to exit]
```

The current turn is aborted via `AbortController` — the LLM stream stops, in-flight tool calls are cancelled, and the prompt returns. The aborted message is NOT persisted to the session history (you can resend it cleanly). Press `Ctrl+C` a second time to exit chat entirely.

The same `AbortController` signal is what surface code uses everywhere — channel adapters, the gateway, web UI. The contract is identical: one signal in, the stream stops, the partial output is dropped.

## 10. One-shot mode for scripts

The REPL is the primary surface, but you can also send a single message and get the reply back without entering chat:

```bash
ethos chat -q "list the built-in personalities by role in one line each"
```

The process streams its answer to stdout and exits when the turn is done. Useful for:

- CI pipelines that ask the agent to summarise a diff or assess a change.
- Shell scripts that route a question to the agent and pipe the answer elsewhere.
- Quick sanity checks during local development without entering the REPL.

The `--query=<text>` and bare `ethos -q <text>` forms are equivalent. The session key is still `cli:<cwd-basename>`, so one-shot queries are persisted into the same session as your interactive use of that directory — useful for sanity-checking what an agent already knows.

## What you learned

- `ethos chat` opens a streaming REPL bound to one personality and one provider.
- The agent emits typed events (`text_delta`, `tool_start`, `tool_end`, `usage`, `done`) — the CLI renders the subset that matters; channel adapters render their own subset off the same stream.
- Sessions persist in SQLite, keyed by `cli:<cwd-basename>`. `/new` starts a fresh one in the same directory; restarting `ethos chat` continues the active one.
- `/usage` reports cumulative tokens and estimated cost; `/budget` reports session spend against the personality's `budgetCapUsd`.
- Switching personality atomically swaps system prompt, tool catalog, model, and memory scope.
- The three built-ins live inside the CLI; user personalities live in `~/.ethos/personalities/<id>/`.

## Next step

You have used the three built-in personalities. The next tutorial builds a fourth — a custom `strategist` personality from scratch, with hot-reload and a memory-scope demo.

- [Create your first personality](./first-personality.md) — `SOUL.md`, `config.yaml`, `toolset.yaml`.
- [Slash commands reference](../reference/slash-commands.md) — every `/command` available in chat.
- [Built-in personalities](../explanation/built-in-personalities.md) — why each of the three ships with the toolset it does.
- [Sessions and history](../explanation/sessions-and-history.md) — what `getMessages` returns and why.
