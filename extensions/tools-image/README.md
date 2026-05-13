# @ethosagent/tools-image

Text-to-image generation via DALL-E 3 or Replicate Flux, with automatic provider selection, cost tracking, and personality toolset gating.

## Why this exists

| Without `image_generate` | With `image_generate` |
|---|---|
| Agent tries `terminal` + `curl` to hit image APIs | Structured tool with typed args and error codes |
| No cost visibility — spend is invisible | `cost_usd` on every `ToolResult` feeds usage telemetry |
| Prompt the LLM actually sent is unknown | `prompt_used` surfaces DALL-E's revised prompt |
| Manual provider selection or hardcoded choice | Auto-pick prefers DALL-E when both keys are set |
| File write can corrupt on partial failure | Atomic write via `Storage.writeAtomic` |

## Tool provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `image_generate` | `image` | Generate a PNG image from a text prompt. |

Factory: `createImageTools(): Tool[]`

## Tool reference

### `image_generate`

```
image_generate({
  prompt: string,                          // required — text description
  output_path?: string,                    // default: ~/.ethos/generated/<timestamp>.png
  size?: '512x512' | '1024x1024' | '1024x1792' | '1792x1024',  // default: 1024x1024
  quality?: 'standard' | 'hd',            // default: standard
  provider?: 'openai-dalle' | 'replicate-flux' | 'auto',        // default: auto
})
```

Returns a JSON string:

```json
{
  "path": "/home/user/.ethos/generated/1715600000000.png",
  "dimensions": { "width": 1024, "height": 1024 },
  "cost_usd": 0.04,
  "provider": "openai-dalle",
  "prompt_used": "A photorealistic cat sitting on a windowsill..."
}
```

`ToolResult.cost_usd` is also set at the top level for usage telemetry. `maxResultChars: 1000`.

## Provider matrix

| Provider | Env var | Model | Sizes | Quality | Cost |
|---|---|---|---|---|---|
| `openai-dalle` | `OPENAI_API_KEY` | DALL-E 3 | 1024x1024, 1024x1792, 1792x1024 | standard, hd | See table below |
| `replicate-flux` | `REPLICATE_API_TOKEN` | Flux Schnell | All sizes (including 512x512) | standard only (quality param ignored) | $0.003/image |

### DALL-E 3 pricing (USD per image)

| Size | Standard | HD |
|---|---|---|
| 1024x1024 | $0.04 | $0.08 |
| 1024x1792 | $0.08 | $0.12 |
| 1792x1024 | $0.08 | $0.12 |

### Auto-pick logic

When `provider` is `auto` (default) or omitted, the tool picks the first available provider in order: `openai-dalle`, then `replicate-flux`. A provider is available when its env var is set.

## Error codes

| Code | Meaning |
|---|---|
| `IMAGE_GEN_NO_PROVIDER` | Neither `OPENAI_API_KEY` nor `REPLICATE_API_TOKEN` is set. |
| `INVALID_SIZE_FOR_PROVIDER` | The chosen provider does not support the requested size/quality combination. |
| `IMAGE_GEN_REJECTED` | The provider refused the prompt (content policy / safety filter). |
| `IMAGE_GEN_QUOTA_EXCEEDED` | Rate limit or quota hit (HTTP 429 or equivalent). |
| `IMAGE_GEN_PROVIDER_UNAVAILABLE` | Provider returned a server error or timed out. |
| `OUTPUT_PATH_DENIED` | The output path is outside the personality's `fs_reach` allowlist (ScopedStorage boundary). |

## Known limitations

- **No editing, inpainting, or variations.** The tool generates from a text prompt only.
- **No local Stable Diffusion.** Only cloud providers (OpenAI, Replicate) are supported.
- **No auto-retry on policy rejection.** A rejected prompt fails immediately; the agent must rephrase.
- **PNG only.** Output is always PNG regardless of the output_path extension.
- **Replicate polling.** Flux uses HTTP polling with a 30 s timeout; long generations may hit this ceiling.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `imageGenerateTool` definition, `createImageTools()` factory, error classifier, storage wiring. |
| `src/auto-pick.ts` | `pickProvider()` — auto-selection logic across available providers. |
| `src/providers/types.ts` | `ImageGenProvider`, `GenerateOpts`, `GenerateResult` interfaces. |
| `src/providers/openai-dalle.ts` | `OpenAIDalleProvider` — DALL-E 3 via the OpenAI SDK, b64_json response format. |
| `src/providers/replicate-flux.ts` | `ReplicateFluxProvider` — Flux Schnell via Replicate HTTP API with polling. |
| `src/__tests__/image.test.ts` | Unit tests for pickProvider, tool validation, size parsing, PNG output integrity. |
| `src/__tests__/openai-dalle.test.ts` | Provider-specific tests for OpenAIDalleProvider. |
| `src/__tests__/replicate-flux.test.ts` | Provider-specific tests for ReplicateFluxProvider. |
| `src/__tests__/integration.test.ts` | Integration test using real `DefaultToolRegistry` with mock providers. |
