# @ethosagent/tools-image

Image generation tool — generate images from text prompts using DALL-E 3 or Replicate Flux, with automatic provider selection and cost tracking.

## Why this exists

Agents working on visual tasks (UI mockups, product images, presentation assets) shouldn't need to leave the conversation to generate images. This package brings image generation inline, writes the output to disk, and reports cost so `budgetCapUsd` accounts for it.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `image_generate` | `image` | Generate a PNG from a text prompt; returns the file path and cost. |

Factory: `createImageTools(): Tool[]`. No dependencies beyond the optional `openai` or `replicate` API keys.

## Tool reference

### `image_generate`

```
image_generate({
  prompt: string,
  output_path?: string,      // default: ~/.ethos/generated/<timestamp>.png
  size?: '512x512' | '1024x1024' | '1024x1792' | '1792x1024',  // default 1024x1024
  quality?: 'standard' | 'hd',  // default standard
  provider?: 'openai-dalle' | 'replicate-flux' | 'auto',        // default auto
}) → { path, dimensions: { width, height }, cost_usd, provider }
```

**Error codes:**
- `IMAGE_GEN_NO_PROVIDER` — neither `OPENAI_API_KEY` nor `REPLICATE_API_TOKEN` is set.
- `IMAGE_GEN_REJECTED` — provider rejected the prompt (content policy / safety filter).

**Cost tracking:** `cost_usd` is returned both in the JSON `value` and as a top-level field on the `ToolResult`, so `AgentLoop` aggregates it into the session's running cost (visible via `/usage` and counted against `budgetCapUsd`).

## Providers

### DALL-E 3 (`openai-dalle`)

Requires `OPENAI_API_KEY`. Uses `dall-e-3` with `response_format: 'b64_json'`.

| Size | Quality | Cost |
|---|---|---|
| 1024×1024 | standard | $0.040 |
| 1024×1024 | hd | $0.080 |
| 1024×1792 or 1792×1024 | standard | $0.080 |
| 1024×1792 or 1792×1024 | hd | $0.120 |

Does not support `512×512` + `hd`.

### Replicate Flux (`replicate-flux`)

Requires `REPLICATE_API_TOKEN`. Uses `black-forest-labs/flux-schnell` via the Replicate REST API. Polls until `succeeded`. Flat cost: **$0.003** per generation regardless of size.

### Auto selection

`provider: 'auto'` (the default) picks the first available provider in order: DALL-E → Flux. If both keys are set, DALL-E is preferred. If neither is set, the tool returns `not_available`.

## How it works

1. Validates `size`, `quality`, and `provider` args.
2. `pickProvider` selects the active backend based on `provider` arg + `isAvailable()` checks.
3. `provider.supports(size, quality)` gates size/quality combos — DALL-E rejects `512x512 hd`.
4. Provider `generate()` returns `{ buffer: Buffer, cost_usd: number }`.
5. `mkdirSync` + `writeFile` saves the buffer to `output_path` (default `~/.ethos/generated/<ts>.png`).
6. Returns path, dimensions, cost, and provider name.

## Gotchas

- The output directory (`~/.ethos/generated/`) is created automatically on first use.
- Replicate Flux always returns a `1024×1024` image regardless of the `size` arg (the API ignores it). The `dimensions` in the result reflect the requested size, not the actual output.
- `512×512` is only supported by DALL-E with `quality: 'standard'`. Requesting `512×512` with `provider: 'auto'` and only `REPLICATE_API_TOKEN` set will fail.
- Cost is reported per-call only. There is no session-level image spend subtotal beyond what `/usage` shows.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `imageGenerateTool` definition, `createImageTools()`. |
| `src/auto-pick.ts` | `pickProvider` — selects provider by name or auto-picks first available. |
| `src/providers/types.ts` | `ImageGenProvider` interface: `{ name, generate, supports, isAvailable }`. |
| `src/providers/openai-dalle.ts` | DALL-E 3 provider; dynamic `import('openai')` so the package doesn't hard-fail without the SDK. |
| `src/providers/replicate-flux.ts` | Replicate Flux provider; pure `fetch`, no SDK dependency. |
| `src/__tests__/image.test.ts` | Unit tests for provider selection, input validation, and output file integrity. |
