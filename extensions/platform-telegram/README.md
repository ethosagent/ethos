# @ethosagent/platform-telegram

## Purpose

Telegram `PlatformAdapter` for Ethos. It long-polls the Bot API via `grammy`, so a bot works with no public URL. It owns Telegram I/O, the slash-command menu, outbox cards and approval cards; dedup, ledger and spool stay in `extensions/gateway`.

## Public surface

Exported from `src/index.ts` (selected; the file is the full list).

| Export | Kind | One line |
|---|---|---|
| `TelegramAdapter` | class | `PlatformAdapter` + `ApprovalCapableAdapter` + `VoiceOutboundAdapter` for one bot. |
| `TelegramAdapterConfig` | type | Constructor options. |
| `chunkText` | function | Splits text at Telegram's 4096-char limit. |
| `reflowChunks` | function | Keeps edited multi-chunk replies coherent. |
| `truncateWithEllipsis` | function | Truncates text to a limit with an ellipsis. |
| `mentionsBot` | function | Whether a message @mentions the bot. |
| `downloadTelegramFile` | function | Downloads a Telegram file with a timeout. |
| `MAX_FILE_SIZE` | const | 25 MB attachment cap. |
| `OutboxCardInput` | type | Input for an outbox card. |
| `InlineButton` | type | Inline keyboard button. |
| `loadTelegramSdk` | function | Lazy loader for `grammy`. |

Subpath exports (`package.json` `exports`): `./validate` (`validateTelegramToken`), `./discover` (`discoverTelegramChats`), `./clarify-surface` (`TelegramClarifySurface`), `./format` (`markdownToTelegramHtml`), `./personality` (`personalityRichMessage`).

## Seam

Implements `PlatformAdapter` and `ApprovalCapableAdapter` from `@ethosagent/types` (checked by `implements` on `TelegramAdapter` in `src/index.ts`). Archcheck layer: `extensions`.

## More

- [docs/setup.md](docs/setup.md): what you can do, five-minute quickstart.
- [docs/operations.md](docs/operations.md): commands, group behaviour, troubleshooting, attachments.
- [docs/internals.md](docs/internals.md): connection model, chunking, bot identity, file table.

## Testing

```
pnpm vitest run extensions/platform-telegram
```

Pinning tests in `src/__tests__/`: `telegram.test.ts`, `outbox-card.test.ts`, `inbound-mention-media.test.ts`, `inbound-media-cap.test.ts`, `privacy-mode-warning.test.ts`, `webhook.test.ts`.
