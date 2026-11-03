# platform-telegram internals

## Internals

### Connection model

Long-polling via grammy's `bot.start()`. No webhook, no public URL. The polling loop runs non-blocking inside `start()` — if the token is invalid, the failure surfaces inside the loop and is logged, not thrown.

### Text chunking

Outbound text is split into 4096-char chunks and sent in order. The splitter prefers newline boundaries, then spaces, both above 60% of the limit. `editMessage()` re-flows chunks via a bounded chunk-id ledger (1024 entries, FIFO eviction).

### Reaction on receipt

On inbound message: set `receiptReaction` (default eyes). On `send()` success: clear it. Both are best-effort, non-blocking.

### Bot identity

At `start()`, personality-bound bots push their identity to BotFather:

- `setMyName` (64-char limit)
- `setMyShortDescription` (120-char limit)
- `setMyDescription` (512-char limit)

All best-effort; team bindings skip this.

### Commands menu

At `start()`, `setMyCommands` registers the gateway commands visible in Telegram's slash picker, derived from the `gateway` surface of the shared registry (`telegramMenuCommands` in `src/index.ts`, over `SLASH_COMMANDS` in `@ethosagent/surface-kit`). Aliases and the owner's pairing commands (`/allow`, `/deny`, `/communications`) are left out of the menu but still run when typed. Plugin commands are appended by `registerCommands`.

---

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `TelegramAdapter`, `TelegramAdapterConfig`, `chunkText`, `truncateWithEllipsis`. |
| `src/blocks/personality.ts` | `personalityRichMessage` — Telegram character sheet renderer. |
| `src/clarify-surface.ts` | Telegram clarify surface (inline keyboards + force-reply). |
| `src/validate.ts` | Config validation helpers. |
| `src/__tests__/` | Unit tests for chunking, identity, commands, reactions, personality card. |
| `package.json` | Workspace package, depends on `grammy` ^1.26. |
