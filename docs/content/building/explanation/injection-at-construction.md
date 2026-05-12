---
title: "Why does AgentLoop receive every dependency at construction?"
description: "AgentLoop takes every collaborator via AgentLoopConfig and never reaches for globals. The trade is wiring code, in exchange for a swappable core."
kind: explanation
audience: developer
slug: injection-at-construction
updated: 2026-05-12
---

## Context

`AgentLoop` is the one core abstraction in Ethos. It is an `AsyncGenerator<AgentEvent>` that takes a user message and streams typed events back — text deltas, [tool](../../getting-started/glossary.md#tool) calls, usage numbers, the final `done` — until the [turn](../../getting-started/glossary.md#turn) is over.

The constructor takes a config object. Inside that object: an `LLMProvider`, a `ToolRegistry`, a `HookRegistry`, a `PersonalityRegistry`, a `MemoryProvider`, a `SessionStore`, an optional `Storage`, optional observability adapters, optional injection classifier, optional watcher, and a handful of tuning options. Every collaborator the loop will ever need — every [hook](../../getting-started/glossary.md#hook) registry, every [session](../../getting-started/glossary.md#session) store, every [personality](../../getting-started/glossary.md#personality) registry — is passed in once at construction.

The constructor never calls `homedir()` to figure out where to read config from. It never imports `node:fs/promises` to read a file. It never sets up an HTTP client to call an LLM. It never reads `process.env` to discover an API key. Every one of those concerns is somebody else's job, and that somebody hands the result in via the config.

This page is about why the runtime is shaped that way, what would break if it reached for globals, and what the convention costs you.

## Discussion

### The contract: nothing reaches for globals

The first behavioural rule in the project's CLAUDE.md, listed under "Core design principles":

> **Injection at construction** — AgentLoop receives every component via AgentLoopConfig. Nothing reaches for globals.

The rule is mechanical. Open `packages/core/src/agent-loop.ts` and search for `process.env`, `homedir`, `import('node:fs')`. You will not find them in `AgentLoop`. The closest thing is `process.cwd()` used as a default for `workingDir` when the wiring did not pass one — a default, not a discovery.

The constructor body is mostly assignment:

```typescript
constructor(config: AgentLoopConfig) {
  this.llm = config.llm;
  this.tools = config.tools ?? new DefaultToolRegistry();
  this.personalities = config.personalities ?? new DefaultPersonalityRegistry();
  this.memory = config.memory ?? new NoopMemoryProvider();
  this.session = config.session ?? new InMemorySessionStore();
  this.hooks = config.hooks ?? new DefaultHookRegistry();
  this.resultBudgetChars = config.options?.resultBudgetChars ?? 80_000;
  this.streamingTimeoutMs = config.options?.streamingTimeoutMs ?? 120_000;
}
```

The defaults are explicitly no-op or in-memory implementations of the same interfaces. They are not the production stack; they are the empty stack. A test that constructs an `AgentLoop` with only an `LLMProvider` gets an in-memory session store, a no-op memory provider, an empty tool registry, and a working hook registry — every collaborator satisfies the interface and does the minimum to keep the loop running.

### What "global" means here

The framework calls a dependency "global" when:

- It is resolved by reading the filesystem (e.g. `homedir()` + `path.join`).
- It is resolved by reading `process.env` for an API key or path.
- It is resolved by calling a singleton getter that does the above.
- It is a `require()` at the top of the file that pulls in a concrete backend.

None of these appear in `AgentLoop` or in `packages/core/`. The interfaces live in `@ethosagent/types`, which has zero runtime dependencies. Concrete backends — `AnthropicProvider`, `SQLiteSessionStore`, `MarkdownFileMemoryProvider`, `FilePersonalityRegistry`, `FsStorage` — live in `extensions/`. The wiring layer (`apps/ethos/src/wiring.ts`, `packages/wiring/src/index.ts`) is the only code that resolves a path or reads an env var.

This layering is the practical answer to "why a constructor argument is better than a global". The same `AgentLoop` is constructed differently by the CLI, by `extensions/web-api/`, by `extensions/gateway/`, by the test suite, and by a future ACP server. Each wires a different set of providers, but the loop's contract — what it depends on, what it returns — is invariant.

### The wiring layer is where decisions happen

`apps/ethos/src/wiring.ts` is the CLI's adapter over `@ethosagent/wiring`. It resolves the LLM key rotation pool, the `~/.ethos` data directory, the working directory, the logger, the observability service, and hands a fully assembled config to `createAgentLoop`. Concrete excerpt from the shape (real code in the repo):

```typescript
const loop = new AgentLoop({
  llm: new AnthropicProvider({ apiKey, model }),
  session: new SQLiteSessionStore({ path: '~/.ethos/sessions.db' }),
  memory: new MarkdownFileMemoryProvider({ dir: '~/.ethos' }),
  personalities: new FilePersonalityRegistry({ dir: '~/.ethos/personalities' }),
  tools: registry,
  hooks: hookRegistry,
  storage: getStorage(),
  observability: ethosObsSingleton,
});
```

The CLI is responsible for reading `~/.ethos/config.yaml` and turning its contents into the constructor argument. The web API does the same job differently — it reads from a service config and picks different backends. The gateway wires telegram, slack, and discord adapters in addition to the loop. All three surfaces share the same `AgentLoop`; the wiring layer is where they diverge.

The principle: **decisions about where things live belong in the surface, not in the runtime.** `AgentLoop` does not know whether the session store talks to SQLite, Postgres, or memory. It calls `session.getMessages(sessionId, { limit })` and consumes the result. The shape of the contract is what's load-bearing; the implementation is a wiring choice.

### What would go wrong with globals

The temptation, when starting a project like this, is to write `AgentLoop` as a class that reads `process.env.ANTHROPIC_API_KEY` and constructs its own `AnthropicProvider`. The code is shorter; the wiring is implicit. Three things break.

**Tests become integration tests.** If `AgentLoop` reads from `~/.ethos/config.yaml`, every test needs that file to exist, or a `tmpdir` fixture, or `mock-fs` patches. Tests that should isolate a single behaviour — "what does the loop do when the session is empty" — turn into ten-line setups that mock the filesystem. The defaults-to-no-op pattern (`InMemorySessionStore`, `NoopMemoryProvider`) makes the same test three lines.

**Surfaces collide.** The CLI lives at `apps/ethos/src/`. The gateway lives at `extensions/gateway/`. The web API lives at `extensions/web-api/`. Each has different idea of where data lives, which credentials to use, which observability backend to ship events to. If `AgentLoop` resolves those on its own, every surface has to monkey-patch the resolution path. The constructor argument is the seam that keeps the surfaces from interfering.

**Swap-ability dies.** The `@ethosagent/types` package declares the interfaces — `LLMProvider`, `SessionStore`, `MemoryProvider`, `PersonalityRegistry`, `ToolRegistry`, `HookRegistry`, `Storage`. Implementing a new backend means implementing the interface and wiring it. If the loop reached for a specific backend by name, "swap the LLM" would be a refactor instead of a constructor argument. Ethos's claim that LLM and session and memory are pluggable rests on the loop not knowing which one is plugged in.

### The defaults are the test stack

A subtle benefit of the contract: the defaults are real implementations that pass the interface, not stubs that throw "not implemented". `InMemorySessionStore` actually stores messages. `NoopMemoryProvider` returns `null` from `prefetch` (which is a valid memory result) and ignores `sync`. `DefaultHookRegistry` is the production hook registry — there is no separate test version.

Construct an `AgentLoop` with just an `LLMProvider`, send it a message, and the loop runs: it creates a session in memory, fires `session_start` hooks (there are none), skips memory prefetch (returns null), builds a system prompt, calls the LLM, executes tools (there are none), syncs memory (no-op), fires `agent_done` (no handlers), and emits `done`. The loop's behaviour at the empty-stack edge is well-defined.

This is why the test directory `packages/core/src/__tests__/` is short. Most behavioural tests construct a loop with a single faked `LLMProvider` and verify event sequences. No filesystem, no environment, no global setup.

### Personalities are injected too — at the registry

A subtlety worth surfacing: the personality is not passed directly. The `PersonalityRegistry` is passed; the loop resolves the active personality from it on every turn. This is what makes hot reload work — `FilePersonalityRegistry.loadFromDirectory()` checks `mtime` on every call, and the next turn picks up an edited `ETHOS.md` without a restart.

The wider rule: the loop does not cache a "current personality" object. It re-reads from the registry each turn so that the live truth on disk is what the next turn sees. The registry is the source; the loop is the consumer.

The same shape applies to tools. The loop does not cache a "current toolset". `DefaultToolRegistry.toDefinitions(allowedTools)` is called per turn with the active personality's `toolset`, and the LLM receives exactly the tools the personality allows right now.

### The `@ethosagent/types` package as the seam

The interfaces live in `packages/types/`. The CLAUDE.md note labels its contract: *zero runtime deps in `@ethosagent/types` — zero imports, zero deps. Every package can import from it safely.*

The zero-dep rule is what makes "depend on the interface, not the implementation" structurally possible. `packages/core/` imports from `@ethosagent/types`; so does `extensions/llm-anthropic/`, `extensions/session-sqlite/`, `extensions/memory-markdown/`, `extensions/personalities/`, and every tool package. None of them imports from each other. The DAG is shaped like a star — types at the centre, every concrete implementation a leaf.

The shape means a new extension (a new memory provider, a new session store) does not require any other package to change. Implement the interface, declare the dependency on `@ethosagent/types`, ship. The wiring layer picks it up if it cares; the rest of the system does not notice.

### What injection at construction does *not* mean

It does not mean every dependency is an interface. `AgentLoop` constructs its own `AbortController` when one is not passed in for the turn. It uses `node:os.homedir()` to expand `${ETHOS_HOME}` in `fs_reach` paths when no `dataDir` is provided. It calls `Date.now()` for timing. It uses `Promise.allSettled` to fan out hook handlers.

The convention is about the *external* collaborators — the things that have a backing service, a backing file, a backing concrete implementation. Internal utilities are allowed to be themselves.

It also does not mean the config is exhaustively typed up front. `AgentLoopConfig` has grown — observability, watchers, injection classifiers, context engines were added over time as `Optional` fields with defaults. The pattern: anything new defaults to `undefined`, the loop falls back to the previous behaviour, and existing wiring code keeps working without changes.

### Storage is the model for the pattern

The cleanest example of the pattern is the `Storage` interface. `AgentLoop` does not import from `node:fs/promises`. It receives an optional `storage: Storage` in its config, decorates it with `ScopedStorage` for the active personality's `fs_reach`, and hands the decorated instance to tools via `ToolContext.storage`. Tools touching the filesystem call `ctx.storage.readFile(path)` rather than reaching for raw `fs`.

Three implementations of `Storage` ship in `@ethosagent/storage-fs`: `FsStorage` for production, `InMemoryStorage` for tests, `ScopedStorage` as the per-personality decorator. A test populates fixtures via `InMemoryStorage.write(path, content)` and constructs an `AgentLoop` with the in-memory storage. No `tmpdir`, no cleanup, no race conditions between tests.

The CLAUDE.md note labels the rule: *new code must NOT import from `node:fs/promises` (or `node:fs`) for `~/.ethos/` access — wire a Storage in via the constructor.* The exceptions are listed exhaustively — SQLite, the sync crash logger, build-time tooling — and they are exceptions exactly because each one breaks the pattern for a reason the framework cannot redesign around.

The same shape applies, with less ceremony, to every other interface. The pattern is "interface in `@ethosagent/types`, default implementation in `extensions/`, injection at the wiring layer". Reading one is reading them all.

### One contract, four surfaces

The clearest way to feel the value of the pattern: read four wiring files side by side.

- `apps/ethos/src/wiring.ts` — the CLI. Reads `~/.ethos/config.yaml`, picks an LLM provider based on `config.provider`, opens a SQLite session store, mounts the markdown memory provider, registers all built-in tools.
- `packages/wiring/src/index.ts` — the shared assembly. The "what goes in an `AgentLoop`" recipe that surfaces compose.
- `extensions/gateway/src/` — the multi-channel gateway. Wires the same loop but also constructs adapters for telegram, discord, slack, email, and the dedup cache.
- `extensions/web-api/` — the HTTP layer. Wires the loop with observability and an approval-hook plumbing for human-in-the-loop confirmations.

Same `AgentLoop`. Same `AgentLoopConfig` shape. Different decisions about which concrete provider to inject for each role. Reading two of these against each other is the fastest way to understand what "injection at construction" buys: when you add a new surface, you do not modify `AgentLoop` — you write a new wiring file.

## Trade-offs

**More wiring code up front.** The CLI's `wiring.ts` is a couple hundred lines of "construct A, pass to B, pass both to C". A framework with globals would let you `import { agent } from '@ethosagent/core'` and start chatting. Ethos asks you to assemble the loop yourself (or call `createAgentLoop` from `@ethosagent/wiring`, which does it once). The trade is the wiring is *legible* — you can read what the loop is going to do before it runs.

**Default backends are no-op, not production.** Construct an `AgentLoop` with just an LLM and you get `InMemorySessionStore`. This is the right default for tests — but a surprise for someone who wanted "sensible defaults plus persistence". The fix is one constructor argument; the surprise is one error away if you forget.

**Long constructor argument lists.** `AgentLoopConfig` has grown to roughly fifteen fields. Most are optional. The TypeScript inference is good enough that you do not feel the weight unless you go looking, but a glance at the type makes it look heavier than it is.

**The wiring layer becomes the integration test surface.** Bugs in how the CLI assembles the loop do not show up in `packages/core/` tests. They live in `apps/ethos/src/__tests__/` and in the end-to-end test harness. The trade is the bugs are *in the wiring file* — readable, debuggable, fixable in one place — rather than distributed across the loop's own behaviour.

Alternatives considered:

- A global registry of providers, populated at startup. Rejected: tests need to clear the registry between cases, surfaces collide, swap-ability becomes a refactor.
- A `Container` / DI framework. Rejected: TypeScript's structural typing makes "interface plus constructor argument" do the same work without the runtime overhead and the magic.
- Reading `~/.ethos/config.yaml` from `AgentLoop`. Rejected: ties the loop to the CLI's filesystem layout; breaks the web API, the gateway, and every test.
- `AgentLoop.fromConfig(path)` static helper. Rejected: reintroduces the global through the back door. The wiring file is the right place for "read this path, then construct".

## See also

- [Why is personality architecture, not a system prompt?](personality-as-architecture.md) — the shape that injection at construction makes possible
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md) — the full assembly diagram
- [AgentEvent reference](../reference/agent-event.md) — what `AgentLoop.run()` actually emits
- [Tool interface reference](../reference/tool-interface.md) — one of the interfaces you would inject
- [Add a memory provider](../how-to/add-a-memory-provider.md) — concrete walkthrough of implementing and wiring an interface
