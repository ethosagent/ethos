---
title: "Serve Ethos as an OpenAI-compatible backend: retries and capabilities"
description: "Retry with Idempotency-Key, probe GET /v1/capabilities, and transcribe audio."
kind: how-to
audience: developer
time: "5 min"
updated: 2026-11-03
---

## Task

Retry a chat request without re-running the agent loop, check which features the server supports, and transcribe an audio file.

## Result

A retried non-streaming request replays the cached response, `GET /v1/capabilities` returns the feature flags, and `POST /v1/audio/transcriptions` returns `{"text": ...}` when an STT provider is configured.

## Prereqs

- Complete [part 1](../openai-server-chat.md): the server is running and you hold an `sk-ethos-...` key with the `chat` scope.
- For transcription, `auxiliary.asr` set in `~/.ethos/config.yaml`.

## Steps

### 7. Retry safely with `Idempotency-Key`

A dropped connection mid-turn leaves a client unsure whether the agent loop ran. Send an `Idempotency-Key` header on `POST /v1/chat/completions` and a retry with the same key and the same request body replays the cached response instead of driving the loop a second time. This only covers non-streaming requests (`"stream": false` or omitted) — a streaming retry (`"stream": true`) with the same `Idempotency-Key` still re-runs the turn, since there is no cached SSE stream to replay.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Idempotency-Key: retry-attempt-1" \
  -H "Content-Type: application/json" \
  -d '{"model": "ethos-default", "messages": [{"role": "user", "content": "Hello"}]}'
```

Reusing the same key with a **different** request body returns `422 idempotency_key_reused` — the key is meant for retrying one request, not for a fresh one. Pick a fresh key (a UUID per attempt is the usual pattern) for each new request.

### 8. Check what the server supports with `GET /v1/capabilities`

Instead of probing with a request that might fail, ask first:

```bash
curl http://localhost:3000/v1/capabilities \
  -H "Authorization: Bearer sk-ethos-..."
```

```json
{
  "byok": true,
  "voice_stt": false,
  "voice_tts": false,
  "chat_completions": true,
  "embeddings": false,
  "audio_transcriptions": false,
  "client_tools": false,
  "system_messages": false
}
```

`chat_completions`, `embeddings`, `client_tools`, and `system_messages` are static — this surface never accepts client-supplied tools, `role: "system"` messages, or embeddings (there is no `/v1/embeddings`; point your client's embedder at its own local model instead). `voice_stt`, `voice_tts`, and `audio_transcriptions` reflect whether an STT/TTS provider is configured in `~/.ethos/config.yaml`. This endpoint requires the same bearer token as every other `/v1/*` route — an unauthenticated request gets `401 invalid_api_key`.

### 9. Transcribe audio with `POST /v1/audio/transcriptions`

When an STT provider is configured (`auxiliary.asr` in `~/.ethos/config.yaml`), `/v1/audio/transcriptions` accepts a multipart file upload and returns the transcript:

```bash
curl http://localhost:3000/v1/audio/transcriptions \
  -H "Authorization: Bearer sk-ethos-..." \
  -F "file=@recording.wav"
```

```json
{"text": "Hello, this is a test recording."}
```

With no STT provider configured, the same request returns `501` with an OpenAI-shaped error body (`code: "stt_not_configured"`), and `audio_transcriptions` reads `false` in `GET /v1/capabilities`. `POST /v1/audio/speech` (text-to-speech) is not implemented.

## Verify

Query the capabilities endpoint.

```bash
curl -s http://localhost:3000/v1/capabilities \
  -H "Authorization: Bearer sk-ethos-..." | jq .chat_completions
```

```
true
```

Send the same non-streaming request twice with one `Idempotency-Key` (step 7). The second response is identical to the first.

## Troubleshoot

**`422 idempotency_key_reused`** — The same `Idempotency-Key` was sent with a different request body. Use a fresh key per new request.
