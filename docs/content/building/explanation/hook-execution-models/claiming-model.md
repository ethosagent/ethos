---
title: "Why does a Claiming hook stop at the first claim?"
description: "The Claiming hook model: sequential, stopping at the first claim."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

This page covers the third of the three hook execution models.

## Discussion

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

## Trade-offs

See [Trade-offs](../hook-execution-models.md#trade-offs) on [Why are hooks split into three execution models?](../hook-execution-models.md).

## See also

- [Why are hooks split into three execution models?](../hook-execution-models.md) — the parent page.
