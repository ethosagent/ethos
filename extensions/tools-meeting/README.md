# @ethosagent/tools-meeting

## Purpose

The `meet_join` tool. It joins a Google Meet URL through an injected meeting client, scrapes captions, and writes the transcript to memory. The browser binding is not wired by default, so the tool reports itself unavailable until a client is configured.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createMeetingTools` | function | Returns the `meet_join` tool. |
| `MeetingToolsOptions` | interface | Meeting client, memory provider, bot display name. |

## Seam

Implements `Tool` from `@ethosagent/types`; writes through `MemoryProvider` and consumes `MeetingClient` from `@ethosagent/platform-meeting`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-meeting
```

Pinning test: `src/__tests__/meet-join.test.ts` holds availability gating (unavailable without a client, available once client and memory exist, `not_available` on execute without a client) and that the tool is marked `requiresApproval`. Limitation: per the comment in `extensions/tools-callcapture/src/index.ts`, `requiresApproval` is announcement-only in the loop; no test here pins it as a gate.
