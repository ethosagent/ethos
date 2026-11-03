# @ethosagent/platform-slack

## Purpose

Slack `PlatformAdapter` for Ethos. It runs in Socket Mode, so a bot serves a Slack workspace with no public URL or webhook. It owns Slack I/O, the `/ethos` slash command, App Home, channel modes and approval cards; dedup, ledger and spool stay in `extensions/gateway`.

## Public surface

Exported from `src/index.ts` (selected; the file is the full list).

| Export | Kind | One line |
|---|---|---|
| `SlackAdapter` | class | `PlatformAdapter` + `ApprovalCapableAdapter` + `VoiceOutboundAdapter` for one Slack app. |
| `SlackAdapterConfig` | type | Constructor options. |
| `ChannelModeSchema` | const | Zod schema for `mention_only`, `thread_follow`, `all`. |
| `DEFAULT_CHANNEL_MODE` | const | Built-in channel mode. |
| `approvalPendingBlocks` | function | Block Kit card for a pending approval. |
| `approvalResolvedBlocks` | function | Block Kit card after a decision. |
| `APPROVE_ACTION_ID` | const | Action id of the Approve button. |
| `DENY_ACTION_ID` | const | Action id of the Deny button. |
| `buildHomeView` | function | Builds the App Home tab view. |
| `chunkText` | function | Splits text for Slack's message ceiling. |
| `reflowChunks` | function | Keeps edited multi-chunk replies coherent. |
| `loadSlackSdk` | function | Lazy loader for the Slack SDK. |

Subpath exports (`package.json` `exports`): `./validate` (`validateSlackToken`), `./clarify-surface` (`SlackClarifySurface`), `./format` (`toNativeMarkdown`, `platformPrompt`).

## Seam

Implements `PlatformAdapter` and `ApprovalCapableAdapter` from `@ethosagent/types` (checked by `implements` on `SlackAdapter` in `src/adapter.ts`). Archcheck layer: `extensions`. Outbound dedup is gateway-only per ARCHITECTURE.md §V S3 (`extensions/gateway/src/dedup.ts`); the adapter has none.

## More

- [docs/setup.md](docs/setup.md): what you can do, app manifest, secrets, config, quickstart.
- [docs/operations.md](docs/operations.md): slash commands, channel modes, threads, App Home, state, troubleshooting, attachments, reactions.
- [docs/internals.md](docs/internals.md): directory layout, key contracts, design notes, file table.

## Testing

```
pnpm vitest run extensions/platform-slack
```

Pinning tests in `src/__tests__/`: `approval-adapter.test.ts`, `channel-mode.test.ts`, `triage.test.ts` (mention and mode triage), `slash-authz.test.ts`, `commands.test.ts`, `home.test.ts`, `download-guard.test.ts`, `file-attachments.test.ts`.
