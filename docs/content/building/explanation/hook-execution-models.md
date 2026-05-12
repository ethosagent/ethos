---
title: "Why are hooks split into three execution models?"
description: "Void, Modifying, and Claiming hooks each fit a different kind of cross-cutting work. Mixing them breaks failure semantics and ordering."
kind: explanation
audience: developer
slug: hook-execution-models
updated: 2026-05-12
---

## Context

Ethos lets you intercept the [turn](../../getting-started/glossary.md#turn) cycle at fixed boundaries. The boundaries are named — `session_start`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_done`, plus channel-level points like `inbound_claim` and `message_sending` — and code can register handlers against each.

The framework calls a registered handler a [hook](../../getting-started/glossary.md#hook). What surprises new contributors is that not every hook fires the same way. There are three execution models — Void, Modifying, and Claiming — and the model is not a runtime flag. It is a property of the hook point itself, baked into the type system. `session_start` is a Void hook. `before_prompt_build` is a Modifying hook. `inbound_claim` is a Claiming hook. You do not get to choose.

This page is about why three rather than one. What each model is for. The failure mode each one is designed to handle. And the small set of consequences for code that registers them.

## Discussion

### Three answers to "what does a hook do"

When you ask "what should happen when a hook fires", you get one of three answers:

- *I want to know it happened.* Log it. Send it to telemetry. Notify another system. The thing the hook does is **react** — it does not change what the agent will do next. Examples: writing an audit log on `session_start`, recording usage on `agent_done`, tracking errors.
- *I want to amend the thing the agent is about to do.* Add to the system prompt. Override a [tool](../../getting-started/glossary.md#tool) argument. Replace the prompt entirely. The hook **mutates the next step's input**, sequentially building up the effective payload. Examples: a plugin injecting "today is Tuesday" into the system prompt, a guard hook overriding a tool's `path` argument to point at a sandbox.
- *I want to decide whether someone else handles this.* A channel adapter claiming an inbound message ("yes, this Telegram update is mine"). A routing hook deciding which surface dispatches the response. The hook **terminates the chain** when one handler says "I've got it"; otherwise the next handler gets a shot. Examples: `inbound_claim`, `before_dispatch`.

Three different failure modes, three different ordering guarantees, three different shapes of return value. Conflating them into one model — say, every hook is fire-and-forget — would force registration code to invent its own discipline for the other two cases. The framework picks the discipline up front and exposes it in the type.

### The Void model: fan-out, ignore failures

`HookRegistry.fireVoid<K>` is the model for side effects. Concretely, in `packages/core/src/hook-registry.ts`:

```typescript
const handlers = (this.voidHandlers.get(name) ?? []).filter(...);
await Promise.allSettled(handlers.map((h) => h.handler(payload)));
```

`Promise.allSettled` is the load-bearing word. Every registered handler fires in parallel. If one throws, the others still complete. The rejection is swallowed — the hook fires the handlers, waits for them all to settle, and returns `void`. The agent loop never learns whether your analytics handler crashed.

This is the right shape for the cases where you want it: logging, analytics, notifications, telemetry, observability events. None of these should be able to abort an agent turn. A flaky analytics service should not cost a user their reply. The fail-open default is a property of the framework, not a discipline you have to remember.

The cost: you cannot use a Void hook to *prevent* something. Returning `false` from a Void handler does nothing — the type system rejects it. If you need to reject a tool call, the hook point is `before_tool_call` (Modifying), not `after_tool_call` (Void).

Void hook points: `session_start`, `before_llm_call`, `after_llm_call`, `after_tool_call`, `tool_end_with_path`, `agent_done`, `message_received`, `message_sent`, `subagent_spawned`, `subagent_ended`.

Pattern of use:

```typescript
hooks.registerVoid('agent_done', async (payload) => {
  await analytics.track('turn_completed', {
    sessionId: payload.sessionId,
    turnCount: payload.turnCount,
  });
});
```

Failure mode by design: handler errors are dropped. The framework does not retry. The framework does not surface them to the caller. If you need observability into your hook's reliability, your hook implementation is responsible for that (a try/catch with a self-report).

### The Modifying model: sequential, first-wins merge

`HookRegistry.fireModifying<K>` is the model for amending the agent's next step. Each handler receives the payload, returns a partial result, and the framework merges the results sequentially — *first non-null value per key wins*.

```typescript
for (const h of handlers) {
  try {
    const result = await h.handler(payload);
    if (result && typeof result === 'object') {
      for (const [k, v] of Object.entries(result)) {
        if (!(k in merged) && v !== null && v !== undefined) {
          merged[k] = v;
        }
      }
    }
  } catch {
    // fail-open: continue with other handlers
  }
}
```

The first registered handler that sets a key sets it. Later handlers can fill in keys the first one left null, but they cannot override. This is the discipline that makes plugin composition predictable: if you register a hook that sets `prependSystem`, and a second plugin also tries to set `prependSystem`, yours wins (you ran first). The second plugin's change does not silently overwrite yours.

The execution is *sequential* on purpose. Modifying handlers may read the partial state that earlier handlers produced. The order matters; running them in parallel would break the first-wins guarantee.

Modifying hook points: `before_prompt_build`, `before_tool_call`, `message_sending`, `personality_switched`, `subagent_spawning`.

Pattern of use — the prompt-build hook from a plugin:

```typescript
hooks.registerModifying('before_prompt_build', async (payload) => {
  return {
    prependSystem: `Today is ${new Date().toDateString()}.`,
  };
});
```

Pattern of use — `before_tool_call` rejecting a dangerous command:

```typescript
hooks.registerModifying('before_tool_call', async (payload) => {
  if (payload.toolName !== 'terminal') return null;
  const args = payload.args as { command: string };
  if (isDangerousCommand(args.command)) {
    return { error: `Blocked: '${args.command}' matches a dangerous pattern.` };
  }
  return null;
});
```

Failure mode by design: handler errors are caught, the merged result keeps what it had, and the next handler still runs. A buggy plugin cannot prevent later handlers from amending the prompt; it also cannot quietly corrupt state — its contribution simply does not appear in the merged result.

There is a non-obvious failure mode worth calling out. A `before_tool_call` hook that wants to reject a tool call **must return `{ error: '...' }`**, not just log and continue. The `AgentLoop` reads the merged result and, when `error` is set, persists a synthetic `tool_result` with `is_error: true` (every `tool_use` block needs a matching `tool_result` block — the Anthropic message contract requires it). If the hook only emits a `tool_end` event but leaves the rejection out of the merged result, the tool still runs.

The CLAUDE.md "Learnings from building this codebase" calls this out explicitly: *the hook fires before `executeParallel`. If you only emit `tool_end ok:false` but still add the tool to `execInputs`, the tool runs anyway. The correct pattern: check `beforeResult.error` → add to a rejected list → exclude from `execInputs`.*

### The Claiming model: sequential, stop at first claim

`HookRegistry.fireClaiming<K>` is the model for routing decisions. Handlers run sequentially; the chain stops as soon as one returns `{ handled: true }`.

```typescript
for (const h of handlers) {
  try {
    const result = (await h.handler(payload)) as ClaimingHooks[K][1];
    if (result && (result as { handled: boolean }).handled) {
      return result;
    }
  } catch {
    // fail-open: try next handler
  }
}
return { handled: false } as ClaimingHooks[K][1];
```

If no handler claims, the framework returns `{ handled: false }` and the caller proceeds with default behaviour. The pattern is "first one to claim wins"; the design is the answer to "which subsystem owns this".

Claiming hook points: `inbound_claim`, `before_dispatch`.

Pattern of use — the gateway's telegram adapter claiming a Telegram update:

```typescript
hooks.registerClaiming('inbound_claim', async (payload) => {
  const msg = payload.message;
  if (msg.platform !== 'telegram') return { handled: false };
  await handleTelegramUpdate(msg);
  return { handled: true };
});
```

Failure mode by design: handler errors are caught, the chain continues. A handler that claims by accident (it intended to return `false` but threw) gets skipped, and the next handler has a chance. The framework's contract is "the first handler that successfully returns `{ handled: true }` wins"; bugs that prevent a handler from returning `true` mean the next handler gets a shot.

The non-obvious property: order of registration matters. Claiming hooks are not commutative. Two adapters that both register an `inbound_claim` for "anything" — the first-registered wins. The wiring layer is where you control which adapter registers first; the framework deliberately exposes the ordering to the caller because routing decisions are first-class.

### How the model determines failure semantics

The three models exist because the right failure semantics are different in each case.

A logging handler should fail open — the agent should not stop running because the audit log is down. Void hooks fail open, fan out in parallel, swallow exceptions.

A prompt-amending handler should also fail open — a buggy plugin should not prevent the agent from building a prompt at all. Modifying hooks catch exceptions, but they preserve first-wins ordering: later handlers cannot overwrite earlier handlers, and an exception does not "fall through" to a later handler that happens to set the same key. The merged result is what it was before the failed handler ran.

A routing handler should fail open in the sense of "if you crash, the next adapter gets a shot at claiming this message". But it should *not* fail open in the sense of "default to the agent processing the message" if the right adapter is down — if you want that behaviour you do not register a claim, because the chain returning `{ handled: false }` is the contract for "nobody claimed". Claiming hooks catch exceptions, but the absence of a claim is a meaningful signal.

The split is not "three for the sake of three". It is three because the failure modes do not compose. A registry that tried to be a single one-size-fits-all model would force every caller to reinvent the discipline.

### What the registry exposes

`HookRegistry` is one interface (defined in `packages/types/src/hooks.ts`). The three models are exposed as three pairs of methods:

- `registerVoid<K>(name, handler, opts?)` ↔ `fireVoid<K>(name, payload, allowedPlugins?)`
- `registerModifying<K>(name, handler, opts?)` ↔ `fireModifying<K>(name, payload, allowedPlugins?)`
- `registerClaiming<K>(name, handler, opts?)` ↔ `fireClaiming<K>(name, payload, allowedPlugins?)`

The type system enforces that you cannot `registerVoid` against a hook point that the type map declares as Modifying. The compile error is the first line of defence; the implementation in `packages/core/src/hook-registry.ts` is the second. You cannot pick the execution model — the hook point picks it for you.

All three `register*` calls return a cleanup function (`() => void`). Call it to deregister. The pattern matches: long-lived registrations (the gateway's telegram claim) live for the process lifetime; short-lived ones (a per-turn audit guard) cleanup explicitly.

The `allowedPlugins` argument on every `fire*` method is the per-personality gate. Built-in handlers always fire; plugin-registered handlers fire only when the active personality's `plugins` allowlist includes their `pluginId`. The point at which gating happens is the framework; the hook handler does not need to check whether the active personality allows it.

### Picking the right model for a new hook point

When a new hook point is proposed, the question is which model fits. The decision tree:

- *Does the handler need to abort or amend what the agent does next?* If yes — Modifying. Read the merged result downstream.
- *Does the handler need to claim ownership and prevent default behaviour?* If yes — Claiming. The first claim wins.
- *Otherwise the handler is a side effect.* Void.

The wrong answer is usually "Modifying" when the right answer is "Claiming", or vice versa. If you want "the first adapter to claim a message wins, others must not run", you want Claiming. If you want "every plugin can amend the prompt, first to set a key wins", you want Modifying.

A Modifying hook used for routing produces handler interference — two handlers both try to set `handled`, and the merge picks one but does not stop the chain. A Claiming hook used for amendment cannot accumulate state — once a handler claims, no later handler gets a shot. The mismatch is real; the framework's job is to prevent you from making it.

## Trade-offs

**Three models are three things to learn.** A simpler framework would have one hook model and let you reach for global state to coordinate cases that do not fit. The trade Ethos makes: the type system tells you which model applies, and the failure semantics are correct by default. The cost is the up-front learning curve.

**You cannot fail closed by default.** All three models swallow handler exceptions. This is intentional — a bug in your audit hook should not crash the agent — but it means you cannot register a Modifying hook and expect "if I throw, the turn aborts". The way to abort a turn from a hook is to return `{ error: '...' }` from a `before_tool_call`, not to throw. The framework's defaults are fail-open; closed failure is opt-in via the payload contract.

**Order of registration is observable.** Modifying hooks merge first-wins; Claiming hooks stop at first claim. Two plugins registering the same hook can interfere if neither knows about the other. The mitigation is the per-personality plugin allowlist — a personality that only allows plugin A does not see plugin B's handlers — but inside one personality, the order is what it is. Plugins that need a specific ordering ship documentation rather than runtime enforcement.

**`Promise.allSettled` for Void hooks means handler latency is visible.** A slow handler holds up the agent loop until it settles. Two-second analytics call on every `agent_done` makes every turn two seconds slower. Void hooks are fire-and-forget in *failure semantics*, not in *latency*. If you need true fire-and-forget, the handler is responsible for kicking off a background task and returning immediately.

Alternatives considered:

- One unified model with a `failureMode` flag per handler. Rejected: callers would always pick the wrong default for the case they were not looking at, and the type system could not enforce correctness.
- A bus pattern (publish/subscribe) for all hooks. Rejected: amendment and routing cannot be modelled as a bus without inventing a side-channel for return values.
- Hook chain `await reduce` semantics (each handler sees the previous result). Rejected for Modifying: makes plugin composition fragile (a plugin's effect depends on the order other plugins registered), and the first-wins merge is more predictable.
- Letting handlers opt into closed failure on Void hooks. Rejected: makes the framework's contract conditional. The opt-in is "return an error from a Modifying hook", which is already supported.

## See also

- [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) — the wiring that exposes the registry
- [HookRegistry reference](../reference/hook-registry.md) — every hook point and its payload type
- [Add a hook](../how-to/add-a-hook.md) — concrete walkthrough of registering one
- [Plugin SDK reference](../reference/plugin-sdk.md) — how a plugin packages hooks for distribution
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md) — where the hook boundaries sit in the turn cycle
