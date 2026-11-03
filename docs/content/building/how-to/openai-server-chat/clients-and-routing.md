---
title: "Serve Ethos as an OpenAI-compatible backend: clients and routing"
description: "Point OpenAI SDKs at Ethos, route model ids to personalities, pin sessions, and the rejected request shapes."
kind: how-to
audience: developer
time: "5 min"
updated: 2026-11-03
---

## Task

Point an OpenAI SDK at the running server, choose which personality answers, and keep history across calls.

## Result

A Python or Node client streams a reply from the personality named in `model`, and calls that share an `X-Ethos-Session` value share one conversation.

## Prereqs

- Complete [part 1](../openai-server-chat.md): the server is running and you hold an `sk-ethos-...` key with the `chat` scope.
- The `openai` Python or Node package, or another OpenAI-compatible client.

## Steps

### 4. Point an OpenAI SDK at it

#### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-ethos-...",
)

resp = client.chat.completions.create(
    model="ethos-default",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

#### Node

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: process.env.ETHOS_API_KEY,
});

const stream = await client.chat.completions.create({
  model: 'ethos-default',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta.content ?? '');
}
```

#### Aider, Cursor, and other clients

Set the OpenAI base URL to `http://localhost:3000/v1` and the API key to your `sk-ethos-...` secret. Most clients expose these as `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables.

### 5. Pick the right `model`

The `model` field maps to one of three shapes, resolved in `apps/web-api/src/routes/openai/chat.ts`:

| Value | Resolves to |
|---|---|
| `ethos-default` | The personality named in `~/.ethos/config.yaml`. Useful when the client cannot be re-configured per call. |
| `<personality-id>` (e.g. `researcher`) | A loaded personality. The id must match an entry from `GET /v1/models`. |
| `team:<name>` | Reserved for team routing. Currently rejected with `400 team_routing_not_implemented`. |

The personality's `toolset.yaml`, model routing, and memory scope all apply transparently. The OpenAI client never sees that part.

### 6. Pin a session across calls

By default each request starts a fresh session. To keep history across calls, pass the `X-Ethos-Session` header:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "X-Ethos-Session: my-aider-session" \
  -H "Content-Type: application/json" \
  -d '{"model": "ethos-default", "messages": [...]}'
```

Reuse the same value across calls and Ethos appends to the same conversation. This is the bridge between OpenAI's stateless wire shape and Ethos's persistent sessions.

## Verify

Run the Python or Node snippet from step 4 with `model="ethos-default"`. The reply streams to stdout token by token.

Send the same `X-Ethos-Session` value on two calls (step 6) and ask the second about the first. The answer reflects the first call.

## Non-goals (explicit rejections)

The route rejects features that are not yet implemented, with a precise OpenAI-shaped error so clients fail loudly:

| Request shape | Error code | Why |
|---|---|---|
| `messages` contains `role: "system"` | `system_messages_not_supported` | The personality owns the system prompt — Ethos rejects any per-request override, rather than silently discarding it. Clear the system prompt in your client instead (in Open WebUI: Admin Settings → Connections → your model's connection, or the active chat's model settings). |
| `tools: [...]` non-empty | `client_tools_not_implemented` | Client-tools mode lands in a later release. Drop the `tools` field. |
| `messages` contains `role: "tool"` | `client_tools_not_implemented` | Same reason. |
| `messages` contains `assistant.tool_calls` | `client_tools_not_implemented` | Same reason. |
| `model` starts with `team:` | `team_routing_not_implemented` | Team routing not wired yet. Use a personality id. |
| `model` is unknown | `model_not_found` (404) | Not in the personalities list or the `ethos-default` alias. |

`content` as an array (vision parts — `[{"type": "text", ...}, {"type": "image_url", ...}]`) **is** accepted: `image_url` parts are translated into attachments the personality can see, and the response carries an `x-ethos-warning` header noting that vision support depends on the personality. `temperature`, `top_p`, `max_tokens`, and `seed` **are** forwarded to the model as sampling parameters — they are not ignored.

## Troubleshoot

**`404 model_not_found`** — `model` is not a known personality id. Call `GET /v1/models` to list valid ids. The `ethos-default` alias is always available.

**`400 team_routing_not_implemented`** — Drop the `team:` prefix; use a personality id directly.

**`400 system_messages_not_supported`** — A `role: "system"` message is in the request. Clear the system prompt in your client (in Open WebUI: Admin Settings → Connections → your model's connection, or the active chat's model settings) — see [Connect Open WebUI to Ethos](../connect-open-webui.md) for the full walkthrough.
