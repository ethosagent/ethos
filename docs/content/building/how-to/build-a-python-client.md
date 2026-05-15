---
title: "Build a Python client with OpenAPI"
description: "Generate a typed Python client from the Ethos /openapi endpoint using openapi-generator-cli."
kind: how-to
audience: developer
slug: build-a-python-client
time: "10 min"
updated: 2026-05-13
---

## Task

Generate a typed Python client for the Ethos web API from the OpenAPI spec, so Python code can create sessions, send chat messages, and read memory without hand-writing HTTP calls.

## Result

A generated Python package with typed methods for every Ethos RPC endpoint. Import it and call `api.sessions.list()` from Python.

## Prereqs

- A running Ethos server with the web API enabled (`ethos serve`).
- Python 3.10+.
- Java 11+ (required by `openapi-generator-cli`).
- npm (to install the generator).

## DX caveat

The TypeScript SDK (`@ethosagent/sdk`) is the first-class client — typed from the same contract the server implements, with SSE support built in. The Python path generates code from the OpenAPI spec, which lags behind contract changes and does not include SSE streaming helpers. Use it when Python is a hard requirement; prefer the TypeScript SDK when you have a choice.

## Steps

### 1. Fetch the OpenAPI spec

```bash
curl http://localhost:3000/openapi -o ethos-openapi.json
```

The `/openapi` endpoint returns a JSON OpenAPI 3.1 spec describing every RPC route.

### 2. Install the generator

```bash
npm install -g @openapitools/openapi-generator-cli
```

### 3. Generate the Python client

```bash
openapi-generator-cli generate \
  -i ethos-openapi.json \
  -g python \
  -o ./ethos-python-client \
  --package-name ethos_client
```

This produces a `ethos-python-client/` directory with:

- `ethos_client/api/` — one module per API namespace (sessions, chat, personalities, memory, etc.).
- `ethos_client/models/` — Pydantic-style dataclasses for every request/response shape.
- `setup.py` — installable package.

### 4. Install and use

```bash
cd ethos-python-client
pip install -e .
```

```python
from ethos_client import ApiClient, Configuration
from ethos_client.api import SessionsApi, ChatApi

config = Configuration(
    host="http://localhost:3000",
    api_key={"Authorization": "Bearer sk-ethos-..."},
)

client = ApiClient(config)
sessions_api = SessionsApi(client)

# List sessions
result = sessions_api.sessions_list(limit=10)
for session in result.sessions:
    print(session.id, session.title)
```

### 5. SSE (manual)

The generated client does not include SSE support. For streaming events, use `httpx` or `sseclient-py` directly:

```python
import httpx

with httpx.stream(
    "GET",
    f"http://localhost:3000/sse/sessions/{session_id}",
    headers={"Authorization": "Bearer sk-ethos-..."},
) as response:
    for line in response.iter_lines():
        if line.startswith("data:"):
            print(line[5:])
```

## Verify

Run a one-line smoke test against a server with at least one session:

```python
print(sessions_api.sessions_list(limit=1).sessions[0].id)
```

It prints a session id without raising. If the API key is wrong, the call raises `ApiException` with status `401`; if the origin is missing from the key's allowlist, status `403`.

## Keeping the client up to date

Re-fetch the spec and re-generate whenever the Ethos server is updated. The OpenAPI spec is generated from the same oRPC contract the TypeScript SDK uses, so it stays in sync with the server — but the generated Python code needs to be regenerated manually.
