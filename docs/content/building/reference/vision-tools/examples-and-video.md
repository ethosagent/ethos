---
title: "Vision tools: examples and video_analyze"
description: "Vision tool examples and the video_analyze tool."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

Worked examples and the video variant of the vision tool. Part of the [Vision tools reference](../vision-tools.md).

## Examples {#examples}

**Image:**

```
vision_analyze({
  file_path: "/Users/me/code/repo/screenshots/error.png",
  prompt:    "What error is shown here? Be specific about the file and line."
})
```

**PDF + structured output:**

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
        vendor: { type: "string" }
      },
      required: ["total", "vendor"]
    }
  }
})
```

**Remote URL:**

```
vision_analyze({
  file_url: "https://example.com/diagram.png",
  prompt:   "Describe the architecture diagram."
})
```

## Video — `video_analyze` {#video-analyze}

Companion tool that analyses a video accessible via HTTPS URL. Same provider plumbing as `vision_analyze`; the model fetches the video itself (Claude / GPT-4o vision endpoints support video-via-URL today).

### Source {#video-source}

[`extensions/tools-vision/src/video.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/src/video.ts) (`createVideoAnalyzeTool`). Capability column lives in the same pricing table: [`extensions/tools-vision/src/pricing.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/src/pricing.ts) — providers without video support refuse with `VIDEO_NOT_SUPPORTED`.

### Schema {#video-schema}

| Field | Type | Required | Description |
|---|---|---|---|
| `file_url` | string | yes | HTTPS URL to the video. SSRF-checked through the same safety pipeline as `vision_analyze`. |
| `prompt` | string | no | Question or instruction. Default: `"Describe this video in detail."` |
| `model` | string | no | Override the resolved model. Must be video-capable. |

Tool metadata: `toolset: 'vision'` (same bucket — a personality with `vision_analyze` typically lists `video_analyze` alongside), `maxResultChars: 30_000`, `capabilities: { network: { allowedHosts: ['*'] } }`, `outputIsUntrusted: true`.

### Limitations {#video-limitations}

- **URL only.** No `file_path` / `file_base64` — the type system has no video-content block for base64 inlining, so local files aren't supported. Upload to an HTTPS-reachable host first.
- **Provider-dependent.** Anthropic and OpenAI's vision-capable chat models accept videos via URL today; refuse with `VIDEO_NOT_SUPPORTED` on other providers.
- **No frame-by-frame extraction.** The model summarises; it doesn't return timestamps or per-frame data structure.
- **Cost.** Video is significantly more expensive per call than images — token accounting flows through the same usage / cost envelope.

### Example {#video-example}

```text
video_analyze({
  file_url: "https://example.com/demo.mp4",
  prompt: "What is the user trying to do in this screen recording? Identify any errors shown."
})
```

Returns the model's text answer plus token usage and dollar cost in the standard envelope.

## See also {#see-also}

- [Vision tools reference](../vision-tools.md): the index of every section and its page.
