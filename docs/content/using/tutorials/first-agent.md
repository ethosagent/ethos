---
title: "Build your first agent"
description: "Run AgentLoop end to end: pick a personality, send three messages, check usage, restart and verify session persistence, switch personality."
kind: tutorial
audience: user
slug: first-agent
time: "10 min"
updated: 2026-11-03
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

## Parts

| Part | Covers |
|---|---|
| 1. Build your first agent (this page) | Steps 1-4: Start chat in a known directory, Send the first message and watch the event stream, Send two more turns and check usage, Watch a tool call up close |
| [2. Sessions, personalities, verbose, one-shot](first-agent-2-sessions-and-personalities.md) | Steps 5-10: Exit, reopen, and prove the session survives, Switch personality and watch the same prompt behave differently, List every personality you can switch to, Verbose mode — read what the framework just did, Interrupt a turn cleanly, One-shot mode for scripts |

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

Researcher is the default. Its [toolset](../../getting-started/glossary.md#tool) is read-heavy — web search, web extract, file read, file search, memory read and write, session search — and its voice is methodical and citation-aware. The other built-ins (`engineer`, `reviewer`) ship different toolsets and voices for different roles. The [Built-in personalities](../explanation/built-in-personalities.md) page explains the design choices behind each.

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

## What you learned

- Steps 1-4 done: Start chat in a known directory; Send the first message and watch the event stream; Send two more turns and check usage; Watch a tool call up close.

## Next step

Continue with [part 2 of 2: sessions, personalities, verbose, one-shot](first-agent-2-sessions-and-personalities.md).
