# tools-vision configuration and usage

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

Mirror of `auxiliary.compression.*` — see [`packages/config/src/index.ts`](../../../packages/config/src/index.ts) `AuxiliaryVisionConfig`.

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


