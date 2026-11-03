---
title: "Peer two Ethos agents over A2A: send and audit"
description: "Give the caller a2a_send, start both servers, send message/send, read audit"
kind: how-to
audience: user
time: "15 min"
updated: 2026-11-03
---

## Task

Send a `message/send` from Agent A to the exposed skill on Agent B and read the resulting audit entries.

## Result

A `curl` to Agent A returns a completion that reports Agent B's reply, and `ethos audit` on B shows the accepted `a2a.rpc` entry.

## Prereqs

- Complete [part 2](peer-identities.md): both agents have each other enabled as peers.
- The two terminals from part 1, each with its own `ETHOS_STATE_DIR` exported (`/tmp/ethos-a` and `/tmp/ethos-b`).

## 7. Give the caller the `a2a_send` tool

The outbound tool, `a2a_send`, is registered only by `ethos serve` and `ethos gateway` — not by `ethos chat` or `ethos -z`. It also has to be on the calling personality's own toolset. **Terminal A**:

```bash
echo '- a2a_send' >> /tmp/ethos-a/personalities/caller/toolset.yaml
```

Personalities are mtime-cached, so this takes effect on the next turn — no restart needed once `ethos serve` is already running.

## 8. Start both servers

**Terminal A**:

```bash
ethos serve --web-port 3000
```

**Terminal B**:

```bash
ethos serve --web-port 3001
```

Leave both running. Open two more terminals for the remaining steps (or background these with `&`).

## 9. Send a message

`a2a_send` runs under the calling personality's own network policy, not the operator key from step 1. `a2a.peering.allowPrivateUrls` lets you *add* a peer on `localhost`; it does nothing for the model's calls. The peer here is on `localhost`, so opt `caller` into private destinations. **Terminal A**:

```bash
cat >> /tmp/ethos-a/personalities/caller/config.yaml <<'EOF'
safety:
  network:
    allow_private_urls: true
EOF
ethos personality show caller | grep G-NET
```

```
| G-NET   | relaxed  | allow_private_urls — RFC1918/loopback/link-local permitted (cloud metadata still blocked); …
```

This widens every network tool on `caller`, not only `a2a_send`. Leave it unset for a peer on the public internet. Cloud-metadata addresses stay refused with it set.

Mint an API key on Agent A for the chat endpoint (new terminal, same `ETHOS_STATE_DIR=/tmp/ethos-a`):

```bash
ethos api-key create --name "a2a-demo"
```

```
✓ API key created  name: a2a-demo

  sk-ethos-abcdef0123456789...

  prefix: sk-ethos-abcdef
  scopes: chat
```

Ask `caller` to reach out to `echo-bot`:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-abcdef0123456789..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "caller",
    "messages": [{
      "role": "user",
      "content": "Use a2a_send to ask the peer at http://localhost:3001/.well-known/agent-card.json?personality=echo-bot for its status. Use skill \"echo-status\"."
    }]
  }'
```

The response is an OpenAI-shaped completion whose `choices[0].message.content` is `caller`'s own reply — it summarizes and attributes what `echo-bot` said, since a peer's words arrive tagged as untrusted, not adopted verbatim. Something like:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "I asked the echo-bot peer for its status. It reports: ... "
    }
  }]
}
```

## 10. Read the audit trail

Both sides logged the exchange as metadata only — never the message body. **Terminal B**:

```bash
ethos audit
```

```
  TIMESTAMP            SEVERITY           CATEGORY / CODE
  ------------------------------------------------------------------------
  2026-08-21 10:14:02  info               a2a.auth a2a-auth
  2026-08-21 10:14:02  info               a2a.rpc message/send
  2026-08-21 10:14:03  info               a2a.task task-state
```

Filter to one surface with `--category`:

```bash
ethos audit --category a2a.rpc
```

`a2a.auth` records the handshake decision (accepted/denied, which fingerprint). `a2a.rpc` records the `message/send` admission decision and which skill was named. `a2a.task` records the terminal task state (`completed`, `failed`, …). None of the three has a field for the message body or the token — the log proves an exchange happened, never what was said.

## Verify

- The curl in step 9 returns `200` with a completion that references the peer's reply.
- `ethos audit --category a2a.rpc` on B shows a `decision: accepted` entry naming `echo-status`.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `not_available` from `a2a_send` | Either A2A is disabled on the caller's install, or the calling personality has no signing key yet (identity was never minted). | Run `ethos a2a enable` and `ethos a2a identity --personality <id>` on the caller. |
| The model never calls `a2a_send` | `a2a_send` isn't on the personality's `toolset.yaml`, or `ethos chat`/`ethos -z` was used instead of `ethos serve`/`gateway` (the only two surfaces that register the tool). | Confirm step 7, and confirm the request went to a running `ethos serve` process. |
| `a2a_send` fails with `refused by this personality's network policy` | The peer is on `localhost` or a private network, and the calling personality has no `safety.network.allow_private_urls: true`. The operator key `a2a.peering.allowPrivateUrls` does not cover the model's calls. | Add the `safety.network` block to the caller's `config.yaml`, as in step 9. |
| `a2a_send` call hangs, then fails after ~30s | The peer accepted the connection but never responded — the outbound client times out rather than hanging forever. | Confirm the peer's `ethos serve` is actually up and A2A is enabled there too. |
