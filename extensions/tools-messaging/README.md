# @ethosagent/tools-messaging

## Purpose

The `send_message` tool, which lets an agent post to another chat. Delivery is an injected send function; this package owns the platform roster, target allowlist refusal, sender-bot binding and the optional approval-outbox gate.

## Public surface

Exported from `src/index.ts`, plus subpath `./compose` (`compose`, `MessagingToolsCompose`), a `WiringContext` entry point.

| Export | Kind | One line |
|---|---|---|
| `createMessagingTools` | function | Returns the `send_message` tool. |
| `MessagingToolsOptions` | interface | Send function, allowed-targets reader, optional outbox. |
| `MessagingSendFn` | type | Delivery function wiring supplies. |
| `SEND_MESSAGE_PLATFORMS` | const | Platforms the tool offers. |
| `OutboxGate` | interface | Approval outbox contract. |
| `OutboxProposal` | interface | What gets queued instead of sent. |
| `OutboxProposalResult` | type | Outcome of proposing to the outbox. |
| `laneSenderBotKey` | function | Reads the sender bot key out of a lane key. |
| `messagingTargetRefusal` | function | Builds the refusal for a target outside the allowlist. |

## Seam

Implements `Tool` from `@ethosagent/types`; `compose` takes a `WiringContext`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-messaging
```

Pinning tests in `src/__tests__/`: `src/__tests__/outbox-gate.test.ts` (queues and says NOT sent; own chat, operator chat and uncovered platforms are not gated), `src/__tests__/sender-binding.test.ts` (`laneSenderBotKey` for channel and thread lanes, none for other platforms), `src/__tests__/send-message-platforms.test.ts` (platform enum and unknown-platform rejection).
