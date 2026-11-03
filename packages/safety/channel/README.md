# @ethosagent/safety-channel

## Purpose

Inbound sender gating for messaging channels: the allowlist and DM-policy filter (`checkMessage`), one-time pairing codes backed by SQLite, and a once-per-window decline slot so a refused sender is told no only once per 24 hours.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `checkMessage` | function | Applies the channel filter to one inbound message. |
| `isSenderAllowed` | function | Whether a sender is on the allowlist. |
| `senderIds` | function | The identifiers a sender may be matched by. |
| `DEFAULT_DECLINE_MESSAGE` | const | Default refusal text. |
| `ChannelFilterConfig` | type | Filter configuration. |
| `ChannelPlatformConfig` | type | Per-platform filter configuration. |
| `ChannelFilterResult` | type | Allow, drop or pairing-reply outcome. |
| `initPairingDb` | function | Creates the pairing tables. |
| `generateCode` | function | Issues a pairing code. |
| `consumeCode` | function | Consumes a pairing code. |
| `consumeAndAllow` | function | Consumes a code and approves the sender. |
| `getApprovedSenders` | function | Lists approved senders. |
| `revokeApproval` | function | Revokes an approved sender. |
| `clearOwnerPause` | function | Clears the owner pause. |
| `claimDeclineSlot` | function | Claims the sender's refusal slot for the window. |
| `DECLINE_WINDOW_MS` | const | Length of the refusal window. |
| `DeclineKey` | type | Platform, bot and sender key of a refusal. |
| `ConsumeResult` | type | Result of `consumeCode`. |
| `ConsumeAndAllowResult` | type | Result of `consumeAndAllow`. |

## Seam

Security-kernel layer (`architecture.config.ts` rule `kernel-reads-contracts`: the kernel imports only contracts and vendored shims, here `@ethosagent/types` and the `@ethosagent/sqlite` shim). ARCHITECTURE.md Law 11 (kernel guarantees are not weakenable from outside) applies. The behaviours are pinned by the tests below; no static rule enforces that channels route inbound messages through this filter (limitation).

## Testing

```
pnpm vitest run packages/safety/channel
```

- `src/__tests__/channel-filter.test.ts`: allow, drop and pairing-reply decisions per DM policy.
- `src/__tests__/pairing-store.test.ts`: code generation, consumption and replay.
- `src/__tests__/decline-store.test.ts`: one refusal per window, a new claim succeeds after it.
