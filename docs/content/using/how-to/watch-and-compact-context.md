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

The ring sits in the composer's action row and shows a percentage, for example `42%`. It is the provider-measured prompt size of the latest model call (system prompt, tool schemas and messages) as a share of the model's window. It refreshes after each model call and when a turn ends (`apps/web/src/hooks/useContextAnatomy.ts`, pinned by `apps/web/src/hooks/__tests__/useContextAnatomy.test.ts`). The number is `total` in `computeContextAnatomy` (`extensions/observability-sqlite/src/context-anatomy.ts`). It is not a sum of input and cache tokens, because providers disagree on whether cached tokens are inside `inputTokens`.

If the model's window is unknown, the meter shows the token count with no ring.

### 2. Open the breakdown

Click the ring. The popover lists five rows with tokens and a share of the window:

| Row | What it counts |
|---|---|
| System | The system prompt, without the memory and skills below |
| Memory | `MEMORY.md` and `USER.md` text, the memory-guidance block and team memory indexes in the prompt |
| Skills | Skill text in the prompt |
| Tool schemas | The tool definitions sent with every request |
| Messages | The conversation so far |

Memory and Skills carry a `≈`. The prompt is measured as one block, and the two are split out by their share of its characters, so they are estimates. System, tools and messages are measured.

The popover also shows the cache-hit rate and a tick on the bar where auto-compaction fires. `computeContextAnatomy` in `extensions/observability-sqlite/src/context-anatomy.ts` produces every number, from the latest model call.

### 3. Watch the warning

The warning state starts at 90% of the auto-compaction point, not 90% of the window. The ring turns amber and shows `⚠` with the number, never color alone (`ContextMeter.tsx`, pinned by `apps/web/src/components/chat/__tests__/context-meter.test.ts`).

Past the point the ring still shows `⚠ NN%`. Only the popover adds a sentence: auto-compaction is due on a coming turn.

**Limitation.** The meter and the compaction trigger can differ slightly on Anthropic. The meter reads the provider-measured request size; the trigger reads the model's reported input tokens, which on Anthropic leave cached tokens out. So the trigger can lag the meter, and a turn past the point may not compact right away. Nothing makes the two identical for that case; `packages/core/src/__tests__/meter-gate-equality.test.ts` pins only that the tick position equals the gate.

### 4. Compact now

Press **Compact now** in the popover. It runs the same compaction as `/compact`, with no focus, and shows the same confirmation toast. Your draft stays in the composer, because the button never reads or writes it.

The button is disabled while a turn runs, during a browser takeover and while its own compaction is in flight (`apps/web/src/pages/__tests__/chat-context-meter.test.ts`, `useContextAnatomy.test.ts`). A typed `/compact` updates the ring the same way.

**Limitation.** It does not lock against other clients or a `/compact` typed in another window. Two compactions at once can race. Nothing refuses the second one: `AgentLoop.compact` takes no turn lock.

Right after compaction the ring shows the compaction's estimated size. Compaction makes no model call, so the estimate stands until the next model call lands, then the ring shows the measured size. Switching sessions drops the estimate.

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
- **Compact now is greyed out.** A turn is running or a takeover is open. Wait or hand back.

## See also

- [Sessions and history](../explanation/sessions-and-history.md)
- [Slash commands reference](../reference/slash-commands.md)
