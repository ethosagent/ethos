# tools-vision capabilities and tool reference

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

Factory: `createVisionTools(opts: VisionToolsOptions): Tool[]`. Production wiring lives in [`packages/wiring/src/index.ts`](../../../packages/wiring/src/index.ts); it builds a `resolveProvider` callback over the personality's primary provider plus an optional auxiliary vision provider.

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

The capability table lives in [`src/pricing.ts`](../src/pricing.ts). Two flags per model — `vision` and `pdf`. Unknown models default to **both flags false**, which surfaces as `VISION_NOT_SUPPORTED` / `PDF_NOT_SUPPORTED` errors.

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


