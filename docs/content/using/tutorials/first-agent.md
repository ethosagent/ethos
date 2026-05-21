---
title: "Build your first agent"
description: "Run AgentLoop end to end: pick a personality, send three messages, check usage, restart and verify session persistence, switch personality."
kind: tutorial
audience: user
slug: first-agent
time: "10 min"
updated: 2026-05-12
---

The CLI is installed and one provider is configured. This tutorial walks the agent turn cycle while you run it: pick a personality, send three messages, watch usage accumulate, prove sessions survive a restart, then switch personality and watch the same prompt behave differently.

## Goal

By the end, you have:

- Sent three turns to one [personality](../../getting-started/glossary.md#personality) and seen the streamed event types render in real time.
- Read the session-level usage report and budgeted it against the model's published price.
- Exited chat and reopened it to confirm the session store returned recent history.
- Switched to a second personality mid-session and seen the same prompt yield a visibly different response shape.

What this tutorial does NOT cover: writing a custom personality, deploying to Telegram, configuring fallback providers. Each of those has its own tutorial below.

## Prereqs

- [Quickstart](../quickstart.md) finished — `~/.ethos/config.yaml` exists, `ethos --version` prints a number, and `ethos chat` reaches the provider.
- A working directory you can `cd` into and remember. Pick one — sessions are keyed by `cli:<cwd-basename>`, so different directories get different histories.
- One free hour of provider quota; the tutorial uses around 10,000 input tokens end to end.
- A terminal wide enough to read streamed text comfortably. The CLI does not wrap aggressively; very narrow terminals make the streamed prose hard to scan.

## 1. Start chat in a known directory

Pick a directory and open chat from inside it. The basename of the directory becomes part of the session key, so the same conversation re-opens later from the same place.

```bash
mkdir -p ~/notes
cd ~/notes
ethos chat
```

The header prints the model, the active personality, and a reminder:

```
ethos  claude-opus-4-7 · Researcher · /help
```

Researcher is the default. Its [toolset](../../getting-started/glossary.md#tool) is read-heavy — web search, web extract, file read, file search, memory read and write, session search — and its voice is methodical and citation-aware. The other four built-ins (`engineer`, `reviewer`, `coach`, `operator`) ship different toolsets and voices for different roles. The [Built-in personalities](../explanation/built-in-personalities.md) page explains the design choices behind each.

## 2. Send the first message and watch the event stream

Type one question. Pick something specific enough to invoke the [tool](../../getting-started/glossary.md#tool) layer:

```
You > what is the current stable Postgres major version? cite the source.
```

Three event categories surface on screen while the [turn](../../getting-started/glossary.md#turn) runs:

- **`text_delta`** — streamed tokens under `ethos >`. The reply begins before the model is done generating; you read it as it arrives.
- **`tool_start` / `tool_end`** — a dim `⟳ web_search` line that flips to `✓ web_search 412ms` when the call returns. The check mark means the tool reported `ok: true`; a red `✗` means it returned `{ ok: false, error, code }`.
- **`usage`** — silent on the line, but accumulated; surfaces through `/usage` later.

What you are watching is `AgentLoop.run()` yielding an `AsyncGenerator<AgentEvent>`. Eight event types live in that stream:

```typescript
type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
```

The CLI renders four of them (`text_delta`, `tool_start`, `tool_end`, `error`) and hides `thinking_delta` by default. Channel adapters render their own subset off the same stream — same contract everywhere.

## 3. Send two more turns and check usage

Ask a follow-up. The agent has the previous turn in [session](../../getting-started/glossary.md#session) history, so refer back to it implicitly:

```
You > what changed in that version's logical replication?
```

The agent recalls the previous question — the session store returned both messages to the LLM as context. `SessionStore.getMessages(sessionId, { limit })` returns the most-recent `limit` messages in chronological order, so the LLM sees the latest exchange, not the oldest.

Now a third turn that synthesises:

```
You > summarise both answers in three bullets.
```

Print the running usage:

```
/usage
```

Expected shape:

```
Tokens  : 4,812 in · 1,907 out
Cost    : $0.05420
```

What the numbers mean:

- **Input tokens** include the system prompt, the [SOUL.md](../../getting-started/glossary.md#ethos-md) of the active personality, any [memory](../../getting-started/glossary.md#memory) prefetch, and every message in the session so far. They grow each turn.
- **Output tokens** count only what the model wrote back.
- **Cost** is the provider's published rate applied to those token counts. It is an estimate — the model's billing dashboard is the source of truth.

If you set [`budgetCapUsd`](../reference/personality-yaml.md#budget-cap-usd) on the personality, `/budget` shows spend against the cap and the next turn refuses with `BUDGET_EXCEEDED` when crossed. `/budget reset` clears the counter; the next turn proceeds.

## 4. Watch a tool call up close

Researcher uses `web_search` for live questions. Trigger one explicitly:

```
You > search the web for "anthropic claude opus 4.7 release notes" and list the top two results.
```

The visible sequence:

```
ethos thinking 1s
  ⟳ web_search
  ✓ web_search 612ms
ethos > 1. ...
        2. ...
```

The `⟳` chip is rendered from `tool_start`; the `✓` from `tool_end`. Failures render `✗ <tool> <error>` instead. Tools execute in parallel inside one turn when the model requests multiple at once — `ToolRegistry.executeParallel` runs them concurrently and splits an 80,000-character result budget across them. Each result is post-trimmed to its share and marked `[truncated]` if it overflows.

Slow tools may push progress events through the [audience boundary](../../getting-started/glossary.md#audience-boundary). The CLI only renders progress events that the tool explicitly tagged for the user. Internal progress (logs, telemetry, dev TUI) stays in `~/.ethos/logs/` and never reaches the terminal.

If a tool fails, the chip flips red:

```
  ⟳ web_search
  ✗ web_search 1208ms
```

The agent still gets the failure as a `tool_result` with `ok: false` and a human-readable error string. The LLM almost always tries to recover — asking a different question, falling back to known information, or asking you to fix the upstream issue. The full failure body is in `~/.ethos/logs/`; the chat surface keeps it terse so a wall of stack traces does not break the flow of conversation.

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
- `/memory` prints `~/.ethos/MEMORY.md` and `~/.ethos/USER.md` when those files are non-empty. Memory is rolling context across sessions; sessions are the per-conversation log. Memory and sessions are different layers — do not confuse them.
- Sessions are pruned by the retention TTLs in [`config.yaml`](../reference/config-yaml.md). The default `retention.messages: 365d` keeps a year of history; tighten it if disk grows or loosen it if you want forever.
- The session store is FTS5-indexed. The `session_search` tool (available to researcher and engineer) can grep across prior sessions for relevant context — handy when you remember solving something in a different working directory.

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
- **Model** — researcher defaults to `claude-opus-4-7`; engineer ships with `claude-sonnet-4-6`. The personality's `model` field overrode the global default for this turn.
- **Memory scope** — both researcher and engineer ship with `memoryScope: global`, so they share `MEMORY.md`. If you had switched to `reviewer`, its `memoryScope: per-personality` would have isolated its memory from the others.

That atomic four-dimensional swap is the headline claim of Ethos. The personality is the unit of architecture; the LLM is the substrate. The [What is a personality?](../explanation/what-is-a-personality.md) page argues for the design choice; the [Personality config reference](../reference/personality-yaml.md) lists every field.

## 7. List every personality you can switch to

```
/personality list
```

Output:

```
Built-ins: researcher · engineer · reviewer · coach · operator
User personalities: ~/.ethos/personalities/<id>/
```

The five built-ins ship with the CLI inside `extensions/personalities/data/`. The user directory is empty until you write one — the next tutorial does exactly that. Switch back to researcher when you are done:

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
ethos chat -q "list the five built-in personalities by role in one line each"
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
- The five built-ins live inside the CLI; user personalities live in `~/.ethos/personalities/<id>/`.

## Next step

You have used the five built-in personalities. The next tutorial builds a sixth — a custom `strategist` personality from scratch, with hot-reload and a memory-scope demo.

- [Create your first personality](./first-personality.md) — `SOUL.md`, `config.yaml`, `toolset.yaml`.
- [Slash commands reference](../reference/slash-commands.md) — every `/command` available in chat.
- [Built-in personalities](../explanation/built-in-personalities.md) — why each of the five ships with the toolset it does.
- [Sessions and history](../explanation/sessions-and-history.md) — what `getMessages` returns and why.
