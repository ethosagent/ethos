# @ethosagent/tools-vision

## Purpose

One-shot vision and PDF question-answering. `vision_analyze` takes an image or PDF plus a prompt and returns the answer with token usage and cost, using the personality's model or a separately configured auxiliary vision model. It is a single-envelope tool, not a streaming chat surface.

## Public surface

From `src/index.ts`; `./compose` is a second package export.

| Export | Kind | One line |
|---|---|---|
| `createVisionTools` | function | Builds the vision tool set (`vision_analyze`, `video_analyze`) from `VisionToolsOptions`. |
| `makeVisionAnalyze` | function | Builds the `vision_analyze` tool alone. |
| `VisionToolsOptions` | type | Options: `resolveProvider`, `defaultModel`, `auxiliaryVisionModel`. |
| `VisionAnalyzeArgs` | type | Argument shape of `vision_analyze`. |
| `createVideoAnalyzeTool` | function | Builds the `video_analyze` tool. |
| `VideoToolOptions` | type | Options for `createVideoAnalyzeTool`. |

## Seam

Implements the `Tool` interface from `@ethosagent/types`; archcheck layer `extensions`. Production wiring is in [packages/wiring/src/index.ts](../../packages/wiring/src/index.ts).

- Magic-byte, size, SSRF and allowlist gates run in `src/input-resolver.ts`; pinned by `src/__tests__/input-resolver.test.ts`.
- Unknown models default to no vision and no PDF support (`src/pricing.ts`); pinned by `src/__tests__/vision.test.ts`.

## More

- [docs/capabilities-and-reference.md](./docs/capabilities-and-reference.md) -- capabilities, tool reference, model fallback, capability table.
- [docs/configuration-and-usage.md](./docs/configuration-and-usage.md) -- `auxiliary.vision.*` config, personality opt-in, examples.
- [docs/errors-and-limits.md](./docs/errors-and-limits.md) -- error codes, v1 limitations, file map.
- [docs/content/building/reference/vision-tools.md](../../docs/content/building/reference/vision-tools.md) -- reference page on the docs site.

## Testing

```
pnpm vitest run extensions/tools-vision
```

Pinning tests: `src/__tests__/vision.test.ts` (happy paths, capability gate, model fallback, JSON schema), `src/__tests__/input-resolver.test.ts` (security gates), `src/__tests__/integration.test.ts` (registry wiring, toolset gating), `src/__tests__/video.test.ts`.
