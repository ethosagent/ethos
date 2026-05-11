---
title: "Add a hook"
description: "Pick the right hook execution model (Void, Modifying, Claiming), register against HookRegistry, and clean up the subscription."
kind: how-to
audience: developer
slug: add-a-hook
time: "10 min"
updated: 2026-05-12
---

## Task

Register a [hook](../../getting-started/glossary.md#hook) at a turn-cycle boundary — `session_start`, `before_tool_call`, `agent_done`, or any other point in `packages/types/src/hooks.ts` — using the correct execution model for what the hook does.

## Result

A handler registered against `HookRegistry`. Every [turn](../../getting-started/glossary.md#turn) that fires that hook calls the handler with a typed payload. The handler returns a cleanup function (or is removed by the plugin loader on `unload`) so re-registering does not leak.

## Prereqs

- `@ethosagent/types` and `@ethosagent/core` (or `@ethosagent/plugin-sdk` for the plugin path).
- Familiarity with `AgentLoop`'s 12-step turn cycle: see `packages/core/src/agent-loop.ts`.
- An understanding of the three execution models. If you have not picked yet, see [Why three hook execution models?](../explanation/hook-execution-models.md).

## Steps

### 1. Pick the execution model

Each hook is registered under exactly one of three models. Picking the wrong one is the most common bug — pick first, code second.

| Model | Method | When to use |
|---|---|---|
| Void | `registerVoid` | Side effects only — logging, metrics, audit trails, notifications. All handlers run in parallel via `Promise.allSettled`; failures are swallowed. |
| Modifying | `registerModifying` | The handler amends the payload — rewriting the system prompt, overriding tool args, swapping the [personality](../../getting-started/glossary.md#personality). Handlers run sequentially; results merge with first-non-null per key. |
| Claiming | `registerClaiming` | Routing decisions — which platform handles this inbound message, which adapter dispatches an outbound message. Handlers run sequentially; the first `{ handled: true }` wins. |

The hook map in `packages/types/src/hooks.ts` is the source of truth. `VoidHooks` lists every Void point and its payload; `ModifyingHooks` lists the payload-plus-result tuples; `ClaimingHooks` is for routing.

### 2. Register the hook

The three patterns differ in the handler signature, not in the registration call. Every `register*` method returns a `() => void` cleanup function; keep the reference if you plan to unregister explicitly.

```ts title="Void — log every session start"
import type { HookRegistry } from '@ethosagent/types';

export function registerSessionLogger(hooks: HookRegistry): () => void {
  return hooks.registerVoid('session_start', async (payload) => {
    console.error(
      `[session-logger] ${payload.sessionId} (${payload.platform}) personality=${payload.personalityId ?? 'default'}`,
    );
  });
}
```

```ts title="Modifying — prepend a safety section to the system prompt"
import type { HookRegistry } from '@ethosagent/types';

const SAFETY = `## Safety
- Never run destructive commands without confirming with the user.
- Prefer dry-run flags before irreversible operations.`;

export function registerSafetyInjector(hooks: HookRegistry): () => void {
  return hooks.registerModifying('before_prompt_build', async (_payload) => {
    return { prependSystem: SAFETY };
  });
}
```

```ts title="Claiming — route a slash command to a custom platform"
import type { HookRegistry } from '@ethosagent/types';

export function registerCustomDispatcher(
  hooks: HookRegistry,
  send: (chatId: string, text: string) => Promise<void>,
): () => void {
  return hooks.registerClaiming('before_dispatch', async (payload) => {
    if (payload.platform !== 'custom') return { handled: false };
    await send(payload.chatId, payload.text);
    return { handled: true };
  });
}
```

### 3. Wire the registration

You have two surfaces for registration: the wiring layer (direct access to `HookRegistry`) and the plugin SDK (`EthosPluginApi` covers Void and Modifying only — Claiming hooks belong to the framework).

```ts title="Wiring path — apps/ethos/src/wiring.ts"
import { DefaultHookRegistry } from '@ethosagent/core';
import { registerSessionLogger } from './hooks/session-logger';

const hooks = new DefaultHookRegistry();
const dispose = registerSessionLogger(hooks);

// Later, on shutdown:
dispose();
```

```ts title="Plugin path — src/index.ts"
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

export function activate(api: EthosPluginApi): void {
  api.registerVoidHook('agent_done', async (payload) => {
    console.error(`[done] ${payload.sessionId}: ${payload.turnCount} turns`);
  });
}

export function deactivate(): void {
  // PluginApiImpl.cleanup() unregisters every hook this plugin added.
}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

The plugin loader passes `{ pluginId }` to every `register*` call so `HookRegistry.unregisterPlugin(pluginId)` removes the subscription atomically when the plugin is unloaded. You do not need to capture the cleanup function in plugin code.

### 4. Know the failure contract

All three models are fail-open: a handler that throws is caught and the next handler runs. The turn never aborts because a hook threw. Design accordingly.

- Void — `fireVoid` runs every handler via `Promise.allSettled`. Throwing inside a handler does nothing visible. If correctness depends on the work happening, write to a durable backend (file, DB) inside the handler and surface a failure through that backend, not through an exception.
- Modifying — sequential handlers swallow errors and continue the merge. A throwing handler contributes nothing to the merged result; subsequent handlers still run.
- Claiming — errors fall through to the next handler. If no handler claims, the result is `{ handled: false }` — the calling code falls back to its default path.

### 5. Test against the real registry

`DefaultHookRegistry` is the production implementation. Use it directly in tests — there is no mock to write.

```ts title="src/__tests__/safety-injector.test.ts"
import { DefaultHookRegistry } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { registerSafetyInjector } from '../safety-injector';

describe('safety-injector', () => {
  it('prepends the safety section to every prompt build', async () => {
    const hooks = new DefaultHookRegistry();
    registerSafetyInjector(hooks);

    const result = await hooks.fireModifying('before_prompt_build', {
      sessionId: 's1',
      history: [],
    });

    expect(result.prependSystem).toContain('## Safety');
  });

  it('does not throw when the hook handler throws', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerVoid('session_start', async () => {
      throw new Error('boom');
    });

    await expect(
      hooks.fireVoid('session_start', {
        sessionId: 's1',
        sessionKey: 'cli:test',
        platform: 'cli',
      }),
    ).resolves.toBeUndefined();
  });
});
```

## Verify

Run the test suite for your hook module:

```bash
pnpm --filter <your-package> test
```

Then exercise the agent end-to-end. For a `session_start` hook you should see the log line on the first message:

```bash
ethos chat -q "ping" 2>&1 | grep '\[session-logger\]'
```

For a `before_prompt_build` hook, run `ethos doctor --show-prompt` (or inspect the system prompt at the start of `apps/ethos/src/commands/chat.ts`) and confirm the injected text is present.

## Troubleshoot

**Handler is registered but never fires.** — The hook is gated by `allowedPlugins`. Built-in (no `pluginId`) handlers always fire; plugin-registered handlers fire only when the personality's plugin allowlist includes the plugin id, or when the call site passes `undefined` for `allowedPlugins`. Check `agent-loop.ts` for the call site.

**Modifying hook's value is ignored.** — `fireModifying` merges first-non-null per key. Another handler earlier in the order returned the same key, so yours is discarded. Reorder by registering earlier, or change the key.

**Claiming hook claimed but the message still went through the default path.** — `fireClaiming` stops at the first `{ handled: true }`; subsequent handlers do not run. Check that no earlier handler is claiming first. Returning `{ handled: false }` is required to pass-through.

**Subscription leaks across tests.** — `DefaultHookRegistry` is stateful per instance. Construct a fresh one per test, or call the cleanup function returned by `register*`.

**`Promise.allSettled` warning floods the logs.** — A Void handler is throwing on every fire. Track down the handler (the stack trace is in the rejected promise) and either fix it or accept the fail-open contract — Void handlers are expected to fail silently.
