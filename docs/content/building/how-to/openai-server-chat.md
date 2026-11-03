---
title: "Serve Ethos as an OpenAI-compatible backend"
description: "Boot ethos serve with the web API enabled, mint an API key and call /v1/chat/completions with curl; SDK clients and extras are in two further parts."
kind: how-to
audience: developer
slug: openai-server-chat
time: "10 min"
updated: 2026-11-03
---

## Task

Point any OpenAI-compatible client — `openai` Python SDK, `openai` Node SDK, Aider, Cursor, custom code — at a running Ethos process. The client thinks it is talking to OpenAI. Your [personality](../../getting-started/glossary.md#personality) picks the actual model and toolset.

## Result

`POST /v1/chat/completions` accepts a bearer token, resolves the `model` field to a personality, and streams (or returns) the assistant's response in the OpenAI wire shape.

## Parts

| Part | Covers |
|---|---|
| 1. Boot, key and curl (this page) | Steps 1-3: start the server, mint a `chat` key, make a first call |
| [2. Clients and routing](openai-server-chat/clients-and-routing.md) | Steps 4-6: Python, Node, Aider and Cursor; the `model` field; session pinning; rejected request shapes |
| [3. Retries and capabilities](openai-server-chat/retries-and-capabilities.md) | Steps 7-9: `Idempotency-Key`, `GET /v1/capabilities`, audio transcription |

## Prereqs

- A working Ethos install (`pnpm dev` from the monorepo or a binary install).
- An LLM provider configured in `~/.ethos/config.yaml`.
- One or more personalities on disk (the built-ins ship by default).

## Steps

### 1. Boot the server

```bash
ethos serve --web-port 3000
```

`--web-port` defaults to `3000`, so this is equivalent to `ethos serve`. Two more flags matter for this surface:

- `--web-host <host>` — bind address. Defaults to `127.0.0.1` (loopback only). Set `--web-host 0.0.0.0` to accept connections from another machine or a container — see [Connect Open WebUI to Ethos](connect-open-webui.md#loopback-only-by-default) for the cookie caveat that comes with it.
- `ETHOS_API_CORS_ORIGINS` (env var) or `web.corsOrigins` in `~/.ethos/config.yaml` — comma-separated origins (or `*`) allowed to call `/v1/*` directly from a browser. Unset means no CORS headers at all. Server-side clients (the OpenAI SDKs, curl, Open WebUI's backend proxy) never need this — see [Connect Open WebUI to Ethos](connect-open-webui.md#cors) for when it applies.

Host, port, and CORS origins can also be set once in `~/.ethos/config.yaml` instead of passed as flags on every boot:

```yaml
web.host: 0.0.0.0
web.port: 3000
web.corsOrigins: "https://chat.example.com"
```

Precedence is **CLI flag > environment variable > config.yaml > default** for host and port. CORS has no CLI flag: **environment variable > config.yaml > default (unset)**.

What this gives you:

- `http://localhost:3000/v1/models` — catalog of personalities in OpenAI shape. `GET /v1/models/{id}` returns one entry.
- `http://localhost:3000/v1/chat/completions` — streaming or non-streaming chat.
- `http://localhost:3000/v1/capabilities` — flat booleans a client can check instead of probing with a failing request (step 7).
- `http://localhost:3000/v1/audio/transcriptions` — speech-to-text, when a provider is configured (step 8).
- The ACP server still runs on `--port 3001` (default).

Both surfaces share the same `sessions.db`, so anything you mint with `ethos api-key` is honored here.

### 2. Mint an API key for the chat scope

`/v1/*` is bearer-gated. Mint a key from the CLI:

```bash
ethos api-key create --name "openai-clients"
```

`--scopes` defaults to `chat`, which is the scope `/v1/chat/completions` requires. The output is shown once:

```
✓ API key created  name: openai-clients

  sk-ethos-abcdef...

  prefix: sk-ethos-abcdef
  scopes: chat
```

Store the secret. You can list keys later (`ethos api-key list`) but the full secret never reappears.

### 3. Try it with curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ethos-default",
    "messages": [{"role": "user", "content": "Hello in one word."}]
  }'
```

`ethos-default` is the alias that resolves to whatever `personality` is in `~/.ethos/config.yaml`. To target a specific personality:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "researcher", "messages": [...]}'
```

List every valid `model` id with `GET /v1/models`.
Continue with [part 2](openai-server-chat/clients-and-routing.md).

## Verify

A non-streaming call returns a `chat.completion` object with `choices[0].message.content` populated:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "ethos-default", "messages": [{"role": "user", "content": "ping"}]}' \
  | jq .choices[0].message.content
```

A streaming call (`"stream": true`) returns `text/event-stream` with `data: {...}` frames terminated by `data: [DONE]`.

## Troubleshooting

**`401 invalid_api_key`** — `Authorization` header is missing, malformed, or the key is unknown. Confirm it starts with `Bearer sk-ethos-` and that `ethos api-key list` shows it as active.

**`403 insufficient_scope`** — The key is missing the `chat` scope. Re-mint with `ethos api-key create --name <label> --scopes chat`.

**The server runs but `/v1/*` returns 404** — Ensure you are running a current version of Ethos. The web API (including the OpenAI surface) always mounts with `ethos serve`.

## See also

- [Connect Open WebUI to Ethos](connect-open-webui.md) — a worked end-to-end setup for the most common OpenAI-compatible client, including the caveats this page only summarizes.
- [Mint a Mission Control API key and build a dashboard](../tutorials/build-custom-dashboard.md) — control-plane SDK for richer UIs.
- [API key scopes](../reference/api-key-scopes.md) — the full scope set the bearer middleware honors.
- [Personalities reference](../reference/personality-registry.md) — what gets exposed as a `model` id.
