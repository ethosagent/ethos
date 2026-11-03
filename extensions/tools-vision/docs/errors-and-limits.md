# tools-vision errors, limits and files

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

- [`docs/content/building/reference/vision-tools.md`](../../../docs/content/building/reference/vision-tools.md) — reference page in the Ethos docs site.
- [`packages/wiring/src/index.ts`](../../../packages/wiring/src/index.ts) — `createVisionTools` registration site; mirrors the auxiliary-compression pattern.
- [`packages/config/src/index.ts`](../../../packages/config/src/index.ts) — `AuxiliaryVisionConfig` and the `auxiliary.vision.*` config-yaml shape.

