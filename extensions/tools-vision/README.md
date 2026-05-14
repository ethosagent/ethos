# @ethosagent/tools-vision

One-shot vision and PDF question-answering — point `vision_analyze` at an image or PDF, supply a prompt, and the active personality's LLM (or a separately configured auxiliary vision model) returns the answer plus token usage and cost.

## Capabilities

| Tool | network | secrets | storage | fs_reach | process | attachments |
|------|---------|---------|---------|----------|---------|-------------|
| `vision_analyze` | — | — | — | `{ read: 'from-personality' }` | — | `{ kinds: ['image'] }` |

### Attachment support

`vision_analyze` declares `capabilities.attachments: { kinds: ['image'] }`. When the user sends an image via a platform adapter (Telegram, Slack), the LLM sees an `<attachments>` block and can pass the opaque `ref` (e.g. `att-0`) as the `ref` argument instead of `file_path`. The tool resolves the ref via `ctx.attachments.openByRef(ref)` to get a local file path, then proceeds with the normal image analysis flow. The `ref` and `file_path` arguments are mutually exclusive -- provide one or the other.

## Why this exists

Reading images or PDFs is a different routing decision from regular chat. The personality you run for coding may not be vision-capable; the cheapest model that *is* vision-capable may not be the one you want answering text-only turns. `vision_analyze` separates the two: the personality keeps its main model for prose, and PDF / image questions route through a vision-capable model picked at request time (with an auxiliary override for "always send vision to this cheap model").

It is intentionally **not** a streaming chat surface — the tool returns a single envelope per call. Multi-turn vision conversations layer on top by repeating calls.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `vision_analyze` | `vision` | Analyze one image (PNG / JPEG / GIF / WEBP) or PDF and return the model's answer + usage. |

Factory: `createVisionTools(opts: VisionToolsOptions): Tool[]`. Production wiring lives in [`packages/wiring/src/index.ts`](../../packages/wiring/src/index.ts); it builds a `resolveProvider` callback over the personality's primary provider plus an optional auxiliary vision provider.

## Tool reference

### `vision_analyze`

```
vision_analyze({
  file_path?:   string,   // absolute path; must lie inside ScopedStorage allowlist
  file_url?:    string,   // HTTPS only; routed through safety-network SSRF gate
  file_base64?: string,   // base64-encoded bytes; optional "data:<mime>;base64," prefix
  prompt:       string,   // question / instruction for the model
  model?:       string,   // override; defaults to auxiliary.vision.model then personality model
  format?: {              // optional: ask the model for parseable JSON
    type:   'json_schema',
    schema: { type: 'object', ... }   // v1: top-level type MUST be 'object'
  },
}) → JSON envelope
```

Exactly one of `file_path` / `file_url` / `file_base64` must be set. `maxResultChars: 8_000`.

#### Return envelope (success)

```json
{
  "text": "the model's answer",
  "parsed": { "...": "..." },   // present only when format.json_schema was supplied
  "model": "claude-opus-4-7",
  "cost_usd": 0.0034,
  "input_tokens": 1287,
  "output_tokens": 48
}
```

`ToolResult.cost_usd` carries the same number as `envelope.cost_usd` so the framework's per-session cost counter (rendered by `/usage`) increments correctly.

#### Model fallback chain

1. `args.model` (caller override) — useful for "use gpt-5 for this one".
2. `auxiliaryVisionModel` — from `auxiliary.vision.model` in `~/.ethos/config.yaml`.
3. `defaultModel` — the active personality's main model.

The first non-null wins. The capability table then gates whichever model was picked.

## Capability table (v1)

The capability table lives in [`src/pricing.ts`](./src/pricing.ts). Two flags per model — `vision` and `pdf`. Unknown models default to **both flags false**, which surfaces as `VISION_NOT_SUPPORTED` / `PDF_NOT_SUPPORTED` errors.

| Model | `vision` | `pdf` |
|---|---|---|
| `claude-opus-4-7` | yes | yes |
| `claude-sonnet-4-6` | yes | yes |
| `gpt-5` | yes | yes |
| `gpt-5-mini` | yes | yes |
| `gemini-2.5-pro` | yes | yes |
| `gemini-2.5-flash` | yes | yes |

Helpers: `supportsVision(model)` and `supportsPdf(model)` (both exported from `@ethosagent/tools-vision`). Adding a model is a one-row edit in `pricing.ts`.

Aliases (dated suffixes) are **not** inferred — list each model id explicitly to keep the gate deterministic.

## Configuration

The tool reads no env vars of its own. Wiring takes its arguments from `~/.ethos/config.yaml`:

```yaml
# Primary chat config (existing) — vision_analyze defaults to this model
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...

# Optional: override the model vision_analyze routes to. Useful when the
# personality's primary model can't process images (e.g. a local llama)
# but you still want vision Q&A available via a cloud model.
auxiliary.vision.model:    claude-sonnet-4-6
auxiliary.vision.provider: anthropic         # defaults to top-level provider
auxiliary.vision.apiKey:   sk-ant-vision-... # defaults to top-level apiKey
auxiliary.vision.baseUrl:  https://...       # defaults to top-level baseUrl
```

Mirror of `auxiliary.compression.*` — see [`apps/ethos/src/config.ts`](../../apps/ethos/src/config.ts) `AuxiliaryVisionConfig`.

### Personality opt-in

Add `vision_analyze` to the personality's `toolset.yaml`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- read_file
- write_file
- vision_analyze
```

Personalities without `vision_analyze` in their toolset never see the tool — the same flat allowlist that gates every other tool.

## Example invocations

**Image:**

```
vision_analyze({
  file_path: "/Users/me/code/repo/screenshots/error.png",
  prompt:    "What error is shown here? Be specific about the file and line.",
})
```

**PDF:**

```
vision_analyze({
  file_path: "/Users/me/docs/invoice.pdf",
  prompt:    "Extract the total amount and the vendor name.",
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        total:  { type: "string" },
        vendor: { type: "string" },
      },
      required: ["total", "vendor"],
    },
  },
})
```

The `format.json_schema` path appends `"Reply with ONLY a JSON object matching this schema: …"` to the prompt and parses the response as JSON; the parsed object lands on `envelope.parsed`. If the model returns non-JSON or omits a required field, the call fails with `RESPONSE_NOT_JSON` (raw text included in the error).

**Remote URL:**

```
vision_analyze({
  file_url: "https://example.com/diagram.png",
  prompt:   "Describe the architecture diagram.",
})
```

The URL is routed through `@ethosagent/safety-network`'s SSRF gate — `http://` is rejected, private IPs are blocked, max 32 MB, redirects bounded.

## Error codes

Tool failures carry a domain-code prefix in the `error` string so callers can pattern-match without parsing the framework's `code`:

| Prefix | `code` | Meaning |
|---|---|---|
| `INVALID_INPUT` | `input_invalid` | Missing prompt, wrong format shape, or zero / multiple file keys. |
| `FILE_NOT_FOUND` | `input_invalid` | `file_path` is outside the personality's `fs_reach` allowlist or does not exist. |
| `URL_BLOCKED` | `input_invalid` | `file_url` is non-HTTPS, points at a private network, or fails the SSRF gate. |
| `FILE_TOO_LARGE` | `input_invalid` | Image > 5 MB or PDF > 32 MB. |
| `UNSUPPORTED_FILE_TYPE` | `input_invalid` | Magic-byte check did not match PNG / JPEG / GIF / WEBP / PDF. |
| `VISION_NOT_SUPPORTED` | `not_available` | The resolved model is not vision-capable, or no `LLMProvider` is configured for it. |
| `PDF_NOT_SUPPORTED` | `not_available` | Input is a PDF but the resolved model does not support PDF. |
| `PDF_TOO_MANY_PAGES` | `execution_failed` | The provider rejected the document on page-count grounds. |
| `LLM_ERROR` | `execution_failed` | Any other provider failure (rate-limit, network, auth). |
| `RESPONSE_NOT_JSON` | `execution_failed` | `format.json_schema` was requested but the model returned non-JSON or omitted a required field. |

## Limitations (v1)

- **One file per call.** No multi-image batching, no document + image mixed prompts.
- **No auto-downscale or paging.** A 6 MB PNG is rejected with `FILE_TOO_LARGE`; a 600-page PDF will likely hit the provider's page cap (`PDF_TOO_MANY_PAGES`). Pre-process before calling.
- **No caching.** Each call is independent. Re-prompting the same file pays the input-token cost again.
- **`format.json_schema` is a tiny validator.** Top-level `type` must be `'object'`; only `required` field presence is checked. Property types are not verified — that's the provider's job. Full JSON-schema validation is out of scope for v1.
- **Capability table is hand-maintained.** Adding a new vision-capable model means editing `pricing.ts` and shipping the table change.
- **No streaming.** The tool buffers the full response before returning. Long answers are clipped at `maxResultChars: 8_000`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `createVisionTools()` factory, `executeVision()`, request-building, JSON-schema validation. |
| `src/input-resolver.ts` | Normalises `file_path` / `file_url` / `file_base64` into `{ mediaType, buffer }`; runs the security gates (allowlist, SSRF, magic-byte detection, size caps). |
| `src/pricing.ts` | The two-flag capability table (`vision`, `pdf`) and `supportsVision` / `supportsPdf` helpers. |
| `src/__tests__/vision.test.ts` | Tool-level unit tests — happy paths, capability gate, model fallback, JSON-schema, provider errors. |
| `src/__tests__/input-resolver.test.ts` | Resolver tests — magic bytes, SSRF, size caps, ScopedStorage allowlist. |
| `src/__tests__/integration.test.ts` | P3 integration — registry-level wiring, toolset gating, image + PDF request shapes, cost aggregation. |

## See also

- [`docs/content/building/reference/vision-tools.md`](../../docs/content/building/reference/vision-tools.md) — reference page in the Ethos docs site.
- [`packages/wiring/src/index.ts`](../../packages/wiring/src/index.ts) — `createVisionTools` registration site; mirrors the auxiliary-compression pattern.
- [`apps/ethos/src/config.ts`](../../apps/ethos/src/config.ts) — `AuxiliaryVisionConfig` and the `auxiliary.vision.*` config-yaml shape.
