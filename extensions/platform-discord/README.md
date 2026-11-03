# @ethosagent/platform-discord

## Purpose

Discord `PlatformAdapter` for Ethos. It connects over Discord's Gateway WebSocket, so a bot serves one or more servers with no public URL or webhook. It owns Discord I/O, the `/ethos` slash command, channel modes and approval cards; dedup, ledger and spool stay in `extensions/gateway`.

## Public surface

Exported from `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `DiscordAdapter` | class | `PlatformAdapter` + `ApprovalCapableAdapter` + `VoiceOutboundAdapter` for one Discord application. |
| `DiscordAdapterConfig` | type | Constructor options: binding, storage, approval roles and policy, command registration. |
| `DiscordClarifyInteraction` | type | Clarify modal interaction shape. |
| `capabilities` | const | `AdapterCapabilities` the adapter advertises. |
| `chunkText` | function | Splits text at Discord's 2000-char ceiling. |
| `reflowChunks` | function | Keeps edited multi-chunk replies coherent. |
| `loadDiscordSdk` | function | Lazy loader for `discord.js`. |

Subpath exports (`package.json` `exports`): `./validate` (`validateDiscordToken`), `./clarify-surface` (`DiscordClarifySurface`), `./format` (`toNativeMarkdown`, `platformPrompt`).

## Seam

Implements `PlatformAdapter` and `ApprovalCapableAdapter` from `@ethosagent/types` (checked by `implements` on `DiscordAdapter` in `src/index.ts`). Archcheck layer: `extensions`. Outbound dedup is gateway-only per ARCHITECTURE.md §V S3 (`extensions/gateway/src/dedup.ts`); the adapter has none.

## Configuration

Config keys, invite URL and scopes: [docs/setup.md](docs/setup.md).

## More

- [docs/setup.md](docs/setup.md): what you can do, ten-minute quickstart.
- [docs/operations.md](docs/operations.md): slash commands, channel modes, threads, approvals, state, troubleshooting, attachments, reactions.
- [docs/internals.md](docs/internals.md): directory layout, key contracts, design notes, file table.

## Testing

```
pnpm vitest run extensions/platform-discord
```

Pinning tests in `src/__tests__/`: `approval.test.ts` (role gate), `routing-triage.test.ts` (mention and channel-mode triage), `threads.test.ts` (thread lanes), `bot-key-routing.test.ts` (multi-bot lanes), `file-attachments.test.ts`, `receipt-reaction.test.ts`.
