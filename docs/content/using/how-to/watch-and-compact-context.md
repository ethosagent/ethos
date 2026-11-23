---
title: "Watch and compact your context"
description: "Read the web Chat context ring, see what fills the window, and compact a long conversation in one click or with /compact from the CLI."
kind: how-to
audience: user
slug: watch-and-compact-context
time: "5 min"
updated: 2026-11-22
---

## Task

See how full the model's [context window](../../getting-started/glossary.md) (the most text a model can read in one request) is, what is filling it, and shrink it before the agent runs out of room.

## Result

You can read the window share in the web Chat composer, open a five-row breakdown, and compact the conversation without losing the message you were typing.

## Prereqs

- A chat with at least one finished turn. Before the first model call there is nothing measured, so the ring is hidden (`apps/web/src/components/chat/ContextMeter.tsx`).
- A [session](../../getting-started/glossary.md#session) (one conversation and its stored history) is the unit: the numbers describe the latest request of that session.

## Steps

### 1. Read the ring

The ring sits in the composer's action row and shows a percentage, for example `42%`. It is the size of the latest request, including [cached](../../getting-started/glossary.md) prompt tokens, as a share of the model's window. Fresh input, cache reads and cache creation are summed, so on Anthropic the number reads larger than it did before this release. That is a correction: the old figure left the cached prompt out.

If the model's window is unknown, the meter shows the token count with no ring.

### 2. Open the breakdown

Click the ring. The popover lists five rows with tokens and a share of the window:

| Row | What it counts |
|---|---|
| System | The system prompt, without the memory and skills below |
| Memory | `MEMORY.md` and `USER.md` text in the prompt |
| Skills | Skill text in the prompt |
| Tool schemas | The tool definitions sent with every request |
| Messages | The conversation so far |

Memory and Skills carry a `≈`. The prompt is measured as one block, and the two are split out by their share of its characters, so they are estimates. System, tools and messages are measured.

The popover also shows the cache-hit rate and a tick on the bar where auto-compaction fires. `computeContextAnatomy` in `extensions/observability-sqlite/src/context-anatomy.ts` produces every number, from the latest model call.

### 3. Watch the warning

The warning state starts at 90% of the auto-compaction point, not 90% of the window. The ring turns amber and shows `⚠` with the number, never color alone.

Past the point, the ring says `⚠ compacting next turn`. A turn compacts unless one ran in the last 5 turns; the cooldown is `cooldownTurns` in `packages/core/src/agent-loop/compaction.ts`. With auto-compaction off it says `⚠ over compaction point`.

### 4. Compact now

Press **Compact now** in the popover. It runs the same compaction as `/compact`, with no focus, and shows the same confirmation toast. Your draft stays in the composer, because the button never reads or writes it.

The button is disabled while a turn runs and during a browser takeover.

**Limitation.** It does not lock against other clients or a `/compact` typed in another window. Two compactions at once can race. Nothing refuses the second one: `AgentLoop.compact` takes no turn lock.

The ring updates after the next turn, not right after compaction. The measured numbers come from the last model call, and compaction does not make one.

### 5. Compact with a focus

To keep something specific, type `/compact` followed by what to keep:

```
/compact keep the database schema decisions
```

The web popover hints at this, but a click never sends a focus.

### 6. Check from the CLI

`/compact status` inside `ethos chat`, and `ethos sessions show <id>` outside it, print the same anatomy:

```
Context anatomy (latest of 4 llm calls)
  system          3,000 tok  2%
  memory ≈        1,200 tok  1%
  skills ≈          800 tok  1%
  tools             900 tok  1%
  messages        3,000 tok  2%
  ─────────────
  total           8,900 tok  7% of 128,000
  compacts at    96,000 tok
  cache hit          80%
  ≈ memory/skills split by size share
```

Both go through `formatContextAnatomy` in `apps/ethos/src/lib/context-anatomy-format.ts`, pinned by `apps/ethos/src/lib/__tests__/context-anatomy-format.test.ts`. The CLI status bar uses the same window; `apps/ethos/src/__tests__/chat-context-window.test.ts` pins that no fixed 200K remains.

## Where the window comes from

One resolution feeds the meter and the compaction gate, so they agree: the `contextWindow` key in your config, then a probe of a local server, then the model catalog, then a default (`resolveContextWindow` in `packages/wiring/src/local-models.ts`). `packages/core/src/__tests__/meter-gate-equality.test.ts` pins that the compaction point shown is the one `maybeCompact` acts on.

## Verify

1. Send two or three messages and open the ring.
2. Confirm the five rows add up to roughly the total.
3. Press **Compact now**, send one more message, and watch Messages shrink.

## Troubleshoot

- **No ring.** The session has no finished model call, or the provider reports no request breakdown. Send a message.
- **`window unknown` in the CLI.** The session's last call predates this feature. Send a message and run it again.
- **The number jumped up after an upgrade.** Cached tokens now count. See the [changelog](../../changelog.md).
- **Compact now is greyed out.** A turn is running or a takeover is open. Wait or hand back.

## See also

- [Sessions and history](../explanation/sessions-and-history.md)
- [Slash commands reference](../reference/slash-commands.md)
