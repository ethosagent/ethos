# @ethosagent/surface-kit

## Purpose

Shared primitives for surfaces (apps and channel extensions): a typed `AgentEvent` translator with a common fold and an audience gate, the reconciled slash-command definitions, a chat-error description map, branch-list helpers, and the approval-card args formatter. Depends only on `@ethosagent/types` and `@ethosagent/safety-redact`.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `createEventTranslator` | function | Builds an `EventTranslator` that folds `AgentEvent`s. |
| `EventTranslator` | type | Translator instance. |
| `EventTranslatorOptions` | type | Options for `createEventTranslator`. |
| `ToolCallState` | type | Per-tool-call state tracked by the translator. |
| `shouldSurfaceProgress` | function | Audience gate for tool progress. |
| `credentialInstruction` | function | Text telling a user how to supply a credential. |
| `credentialSetCommand` | function | The credential-set command string. |
| `SLASH_COMMANDS` | const | Reconciled slash-command definitions. |
| `parseSlashCommand` | function | Parses a message into a slash command. |
| `resolveSlashCommand` | function | Resolves a name or alias to a definition. |
| `getSlashCommand` | function | Looks up one definition. |
| `slashCommandsForSurface` | function | Commands available on a surface. |
| `SlashCommandDef` | type | One slash-command definition. |
| `CHAT_ERROR_MAP` | const | Error code to user-facing description map. |
| `describeChatError` | function | Describes an error for a chat surface. |
| `formatApprovalArgs` | function | Formats tool args for an approval card. |
| `truncateWithMarker` | function | Truncates text with `TRUNCATED_MARKER`. |
| `formatBranchList` | function | Formats a session branch list. |
| `pickBranch` | function | Chooses a branch from user input. |
| `BRANCH_USAGE` | const | Usage text for branch commands. |

Plus related types and `TRUNCATED_MARKER`, see `src/index.ts`.

## Seam

Consumes the `AgentEvent` contract from `@ethosagent/types`. Archcheck layer `support`. The package.json states it avoids a layer cycle by depending only on types and `@ethosagent/safety-redact`; the import limits for the `support` layer are in `architecture.config.ts`.

## Testing

```
pnpm vitest run packages/surface-kit
```

- `src/__tests__/event-translator.test.ts`: text accumulation order, usage summing, first error and done latching.
- `src/__tests__/slash-commands.test.ts`: slash-command parsing and resolution.
- `src/__tests__/chat-error-map.test.ts`: chat error descriptions.
- `src/__tests__/approval-args.test.ts`: approval args formatting and truncation.
