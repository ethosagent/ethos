# @ethosagent/tools-social-search

## Purpose

Search tools for social sites. Quora, LinkedIn and Reddit are searched through the web with site filtering and de-duplication; YouTube uses the YouTube Data API for search and comments. Reddit's official API is in `tools-reddit`.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths). Main entry points.

| Export | Kind | One line |
|---|---|---|
| `createQuoraSearchTool` | function | Builds `quora_search`. |
| `createLinkedInSearchTool` | function | Builds `linkedin_search`. |
| `createRedditWebSearchTool` | function | Builds `reddit_web_search`. |
| `createYouTubeSearchTool` | function | Builds `youtube_search`. |
| `createYouTubeCommentsTool` | function | Builds `youtube_comments`. |
| `quoraSearchTool` | const | Default Quora instance. |
| `linkedInSearchTool` | const | Default LinkedIn instance. |
| `redditWebSearchTool` | const | Default Reddit-web instance. |
| `youtubeSearchTool` | const | Default YouTube search instance. |
| `youtubeCommentsTool` | const | Default YouTube comments instance. |
| `parseYouTubeVideoId` | function | Extracts a video id from a URL or bare id. |
| `SiteProfile` | interface | Per-site path filter profile. |
| `QUORA_PROFILE` | const | Quora profile. |
| `LINKEDIN_PROFILE` | const | LinkedIn profile. |
| `REDDIT_PROFILE` | const | Reddit profile. |

## Seam

Implements `Tool` from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-social-search
```

Pinning tests in `src/__tests__/`: `src/__tests__/site-search.test.ts` (Quora results never include profile or topic URLs, look-alike hosts are dropped by host equality, URL variants collapse to one entry), `src/__tests__/youtube-ids.test.ts` (accepted and malformed id forms), `src/__tests__/youtube-search.test.ts` and `src/__tests__/youtube-comments.test.ts` (availability and input validation).
