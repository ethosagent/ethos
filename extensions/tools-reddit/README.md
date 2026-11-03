# @ethosagent/tools-reddit

## Purpose

Reddit research tools over Reddit's official OAuth API: `reddit_search` and `reddit_thread`. Credentials are two named secrets read through `ctx`; the package caches the app-only access token. Search through the open web is a separate package, `tools-social-search`.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createRedditSearchTool` | function | Builds `reddit_search`. |
| `redditSearchTool` | const | Default instance. |
| `RedditSearchArgs` | interface | Search input (query, subreddit, sort, time filter, limit). |
| `RedditSort` | type | Sort values. |
| `RedditTimeFilter` | type | Time filter values. |
| `createRedditThreadTool` | function | Builds `reddit_thread`. |
| `redditThreadTool` | const | Default instance. |
| `parseRedditPostId` | function | Extracts a post id from a URL, path or bare id. |

## Seam

Implements `Tool` from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-reddit
```

Pinning tests in `src/__tests__/`: `src/__tests__/auth.test.ts` (token cached per credential pair, refetched after expiry), `src/__tests__/reddit-search.test.ts` (availability, `not_available` without capability backends, input validation), `src/__tests__/reddit-thread.test.ts` (`parseRedditPostId` accepted URL forms).
