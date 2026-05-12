---
title: "Why does tool progress have an audience field?"
description: "The audience field gates which tool_progress events surfaces render. Default is internal; the tool author opts a specific event into user-visible."
kind: explanation
audience: developer
slug: audience-boundary
updated: 2026-05-12
---

## Context

A [tool](../../getting-started/glossary.md#tool) can emit progress while it runs. The pattern is `ctx.emit({ type: 'progress', toolName, message })` — a string that says "still reading", "page 3 of 12", "compiling", whatever the tool wants to surface. The `ToolProgressEvent` is fanned out as a `tool_progress` [agent event](../../getting-started/glossary.md#agent-event) on the run generator, and any subscriber can read it.

The question is *which* subscribers should render it. Logs and telemetry — always. The CLI's verbose dev mode — usually. A user reading a Telegram thread on their phone — almost never. Twenty "page 3 of 12" chips landing in a Slack channel from a `read_file` reading a long log file is noise, not signal.

Ethos solves this with an [audience boundary](../../getting-started/glossary.md#audience-boundary). Every `tool_progress` event carries an `audience` field — `'internal'` (the default) or `'user'` — and surface code gates rendering on it. The default is internal because internal is what *almost every* tool progress message is for. The tool author explicitly opts in to `'user'` for the cases that justify the noise.

This page is about why the gate exists, where it sits in the stack, and the contract surfaces must honour.

## Discussion

### The default is silent, on purpose

The `audience` field on `ToolProgressEvent` is declared in `packages/types/src/tool.ts`:

```typescript
export interface ToolProgressEvent {
  type: 'progress';
  toolName: string;
  message: string;
  percent?: number;
  audience?: 'internal' | 'user';
}
```

When a tool emits without specifying `audience`, the value is `undefined` — which the framework treats as `'internal'`. This is the right default because the framework cannot know whether the user wants to see a given progress message. Defaulting to `'user'` would mean every tool that emits at all becomes chatty by accident. Defaulting to `'internal'` means tools have to argue for visibility.

The CLAUDE.md note frames the design directly:

> The framework never opts in for the tool. `'user'` is per-event opt-in by the tool author.

Per-event is the load-bearing word. A tool may emit ten progress events during a long operation and mark only one of them as `'user'` — the message that says "this is going to take a while" — while keeping the heartbeat updates internal. The granularity is the event, not the tool.

### What surfaces render what

Every consumer of the agent event stream gates on `audience`. The contract:

- **Framework-internal consumers** (logs, telemetry, observability writer, the dev TUI in verbose mode) read *all* `tool_progress` events. They are watching the agent's behaviour, not relaying messages to a person.
- **User-facing surfaces** (channel adapters in `extensions/platform-*/`, the CLI's chat REPL in `apps/ethos/src/commands/chat.ts`) read only events with `audience: 'user'`.

The split is the surface code's job. The framework emits the event with the field set; the surface filters. This is consistent across every channel — Telegram, Discord, Slack, WhatsApp, Email, plus the CLI's interactive chat — because the same contract reaches all of them.

Concrete example: a `read_file` tool reading a 5MB log emits `'reading bytes 0-65000'`, `'reading bytes 65000-130000'`, and so on as `'internal'` progress. The observability writer records each one for debugging. The Slack adapter sees them and drops them. The user sees nothing until the tool returns `ok: true` with the result. If the read takes long enough that silence would be confusing, the tool emits *one additional* event with `audience: 'user'`: "Reading a large file, this will take a few seconds." That one renders.

### Same gate, two event types

Phase 30.2 extended the boundary to `tool_end` events too. When a tool succeeds (`ok: true`), the `tool_end` event carries an `audience` field that follows the same rule: surfaces render it only when `'user'`. Failure events (`ok: false`) ignore the field and always render — a tool error is news the user needs.

The reason `tool_end` got the field: the natural pattern is for a tool to mark its final `tool_progress` and its `tool_end` consistently. If the long-running operation was surfaced ("this will take a few seconds"), the user expects a closing chip ("done"). The framework cannot infer that — but the tool can set both events the same way.

For most tools, `tool_end` defaults to `'internal'`. The CLI's compact ASCII chip showing `[ok read_file]` after a turn is a separate dev convenience; channel adapters that show a per-call chip ("ran read_file") gate on `audience: 'user'`.

### Where the gate lives in code

Three places enforce it:

- **`apps/ethos/src/commands/chat.ts`** — the CLI's interactive chat REPL. Filters `tool_progress` and successful `tool_end` events on `audience: 'user'` before rendering. The verbose flag (`--verbose`) flips the filter off so developers can see everything.
- **`extensions/gateway/src/`** — the channel-adapter gateway. Each adapter (telegram, discord, slack, whatsapp, email) consumes the agent event stream and gates on the audience field before sending an outbound message. Adapters do not roll their own logic; the gateway is the chokepoint.
- **Framework-internal consumers** — `apps/ethos/src/logger.ts`, `extensions/observability-sqlite/`, the watcher in `packages/safety/watcher/`. These read every event. They are the audit trail; they care about everything that happened.

The pattern: surface code reads `event.audience === 'user'`. Framework code reads everything. The framework does not filter; it merely tags.

### Why a string enum, not a boolean

`'internal' | 'user'` rather than `userVisible: true | false`. Three reasons.

The semantic is clearer when read in code. `if (event.audience === 'user')` says what the gate does without the reader inferring the convention from a boolean.

The value space is open. A future `'admin'` audience for events that should surface to a workspace admin's dashboard (but not the user's chat thread) is a one-value addition. A boolean would require a new field.

The default is grammatically natural. The absence of a value (`undefined`) treats as `'internal'`. A boolean defaulting to `false` would invert the reading: `userVisible: false` looks like "this event is suppressed" rather than "this event is the framework's business".

### What this is not

It is not a permissions system. The `audience` field does not restrict who can *read* the event; it advises who should *render* it. A malicious surface implementation could read all events and forward them anywhere. The contract is a convention enforced by every framework-shipped surface, not a cryptographic guarantee.

It is not a way to suppress logging. Internal events still hit the logger and the observability writer. The gate is for what reaches *the user*, not for what the framework records. Channel adapters that need to log everything continue to log everything; they just do not *send* everything outbound.

It is not the same as the `outputIsUntrusted` flag. That flag (also on `Tool`) controls whether the tool's *output* is wrapped as adversary-controlled before going to the LLM. The audience field controls whether *progress chatter* surfaces to the user. Orthogonal concerns — a tool with untrusted output may still have user-visible progress, and vice versa.

### How tools decide when to opt in

The CLAUDE.md note gives the rule of thumb:

> Use [`'user'`] sparingly: long-running operations where silent latency would be confusing.

Two cases worth opting in for:

- **A read that crosses an obvious user expectation.** `read_file` on a file >1MB. The user typed "read this file" and a half-second silence is fine; a five-second silence with no chip looks broken. One `'user'` progress event ("reading 1.2MB, this will take a few seconds") clears it up.
- **A multi-step tool with phase boundaries.** A `bash` command running `npm install` could emit `'installing dependencies'`, `'compiling', 'running tests'` as `'user'` — three chips that map to recognisable phases. The intermediate spinner updates stay internal.

When in doubt, leave it internal. The user can ask for verbose mode if they want everything. The default surface is the lean one.

## Trade-offs

**You commit to per-event tagging.** A tool author who emits ten progress events has to remember which ones merit `'user'`. The mitigation is the default — leaving the field off does the right thing for the silent-by-default case — but tools that *do* want some user-visible chatter pay the per-event cost of marking the ones that warrant it.

**Surfaces have to agree.** The gate works because every framework-shipped surface gates the same way. A third-party adapter that ignores the field would relay everything, defeating the design. The contract is enforceable only in code review, not at the type level. The CLAUDE.md note labels this clearly: "Channel adapters MUST NOT surface [internal events] to the user."

**You cannot dynamically reclassify.** An event emitted as `'internal'` cannot later become `'user'` based on downstream context. If a tool started emitting internal-only updates and the user-facing surface later decided the wait was too long, there is no event in the stream tagged `'user'` to render. The mitigation is for the tool author to error on the side of one `'user'` event up front when the operation might run long.

**Two-valued for now.** `'internal' | 'user'` covers the two cases that exist. A future `'admin'` for ops dashboards or `'audit'` for compliance feeds would extend the enum and every adapter would need to gate against the new value. The cost of adding a value is real but bounded.

Alternatives considered:

- A `verbose: boolean` field defaulting to `false`. Rejected: the semantic is harder to read, and the field name implies a CLI flag rather than a surface contract.
- A per-tool default audience (tools mark their tool as "chatty" or "quiet" once). Rejected: progress messages from one tool often want different audiences. A `read_file` reading 50k is internal; a `read_file` reading 5MB warrants one user-visible chip.
- Surface-side heuristics ("if a tool runs longer than X seconds, render its progress"). Rejected: heuristics are inconsistent across surfaces and unpredictable for tool authors. The explicit per-event tag is auditable.

## See also

- [Why is there an 80k tool result budget?](tool-result-budget.md) — orthogonal: bounds the *result*, not the progress chatter
- [Tool interface reference](../reference/tool-interface.md) — the `ToolProgressEvent` and `Tool.execute` contract
- [AgentEvent reference](../reference/agent-event.md) — every event the run generator emits, including `tool_progress` and `tool_end`
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md) — where surfaces consume the event stream
