# @ethosagent/tools-a2a

## Purpose

Outbound A2A tool. `a2a_send` lets a personality send a message to a peer agent over the A2A protocol. It is a thin surface over `A2aOutboundClient` from `@ethosagent/a2a`; identity, peer verification, allowlist and delegation limits live there, and this package adds the per-personality session cache.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createA2aTools` | function | Returns the outbound toolset (`a2a_send`). Register only when A2A is enabled. |
| `A2aToolDeps` | interface | Identity provider, secrets resolver, egress allowlist and client wiring. |

`A2aSessionCache` and `A2aSessionCacheOptions` live in `src/session-cache.ts` and are used internally.

## Seam

Implements `Tool` from `@ethosagent/types` and consumes `A2aIdentityProvider` and `SecretsResolver` from the same package. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-a2a
```

Pinning tests in `src/__tests__/`: `src/__tests__/tools-a2a.test.ts` (round-trip, one handshake across repeat sends, a revoked peer fails on the next send, delegation budget refuses the second fan-out, self-loop guard), `src/__tests__/session-cache.test.ts` (per-personality keys, expiry safety margin, invalidate).
