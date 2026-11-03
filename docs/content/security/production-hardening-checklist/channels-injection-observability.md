---
title: "Production hardening: channels, injection, observability and containers"
description: "Steps 5-9: channel filter, injection checks, audit, containers, bot bindings."
kind: how-to
audience: shared
time: "10 min"
updated: 2026-11-03
---

## Task

Configure channel security, confirm injection defenses, set up observability and retention, harden the container and validate bot bindings.

## Result

Every step on this page is applied and the checks in [Verify](../production-hardening-checklist.md#verify) on the main page pass.

## Prereqs

Complete the [Prerequisites](../production-hardening-checklist.md#prerequisites) listed on the main page, [Production hardening checklist](../production-hardening-checklist.md).

## Steps

### 5. Configure channel security

Set up `channel_filter` in `~/.ethos/config.yaml` for every active channel adapter:

- **Sender allowlist:** restrict which user IDs can reach the agent. Unknown senders are dropped before the message enters the agent loop.
- **DM pairing codes:** with `dmPolicy: pairing` (the default), an unknown sender who DMs the bot gets a one-time code, and only the owner can redeem it with `/allow <code>`. Codes are random, bound to the sender they were issued for, single-use, and expire after an hour.
- **Context visibility:** set `contextVisibility: allowlist` to strip quoted replies to non-allowlisted senders and their lines of channel history. `allowlist_quote` is an alias with the same behaviour. Avoid the default `all` in production unless the channel is fully trusted.

See [Security controls -- channel](.././controls.md#channel-level-controls) for the full set of channel-layer controls.

```yaml
channel_filter.telegram.ownerUserId: 123456789
channel_filter.telegram.recipientAllowlist: 234567890,345678901
channel_filter.telegram.dmPolicy: pairing
channel_filter.telegram.contextVisibility: allowlist
channel_filter.slack.ownerUserId: U01ABC123
channel_filter.slack.contextVisibility: allowlist
```

**Verify:** Send a message from a non-allowlisted account. Confirm it is dropped (a DM gets a pairing code instead of an answer) and that an `audit.block` event with code `channel.allowlist.blocked` (DM) or `channel.mention_gate` (group) appears in `observability.db`.

### 6. Confirm injection defenses are active

The `INJECTION_DEFENSE_PRELUDE` system prompt is always-on -- it is injected into every personality's prompt automatically. No action is needed to enable it.

Confirm that `wrapUntrusted` covers all untrusted input surfaces:

- **Channel messages:** the gateway wraps every admitted inbound message, and any channel history attached to it, with provenance markers.
- **Tool results:** a result is wrapped only when its tool declares `outputIsUntrusted: true` — `web_extract`, `read_file`, `search_files`, `terminal`, the browser page-reading tools and MCP tools among them. A tool that does not declare it is not wrapped, and its results do not arm the post-read downgrade.

The only case where action is required: if you have written **custom tools** that return external content, set `outputIsUntrusted: true` on each of them. The agent loop then wraps the result, runs the pattern check, and arms the post-read downgrade (`handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`).

**Verify:** No explicit verification step unless you have custom tools. If you do, confirm each custom tool that returns external content declares `outputIsUntrusted: true`.

### 7. Set up observability and retention

Confirm the audit substrate is writing:

```bash
# Check that observability.db exists and is receiving events
ls -la ~/.ethos/observability.db
sqlite3 ~/.ethos/observability.db "SELECT category, COUNT(*) FROM events GROUP BY category;"
```

Confirm credential redaction is active. Redaction is always-on at the observability store layer -- `redactString` and `redactJson` fire before any value reaches disk. The per-personality `safety.observability` knob controls storage granularity:

| Mode | What is stored |
|---|---|
| `none` | Events only (no tool args, no tool bodies, no LLM payloads) |
| `redacted` | Tool args and bodies stored after pattern-based redaction |
| `full` | Everything stored (use only in development) |

Set retention policies per audit category. Production deployments should retain `audit.*` and `channel.*` events for at least 90 days.

```yaml
# In config.yaml
observability:
  retention:
    "audit.*": "90d"
    "channel.*": "90d"
    "install.*": "30d"
```

**Verify:**

```bash
# Confirm redaction is working — inject a test key pattern and check the log
sqlite3 ~/.ethos/observability.db \
  "SELECT data FROM events ORDER BY rowid DESC LIMIT 5;"
# No raw API keys (sk-ant-*, AKIA*, xoxb-*) should appear in the output.
```

### 8. Harden the container (Docker deployments)

If running Ethos in Docker, apply these constraints:

| Setting | Value | Why |
|---|---|---|
| User | Non-root (`USER 1000:1000`) | Limits blast radius of any escape |
| Root filesystem | Read-only (`--read-only`) | Prevents runtime binary replacement |
| Inbound ports | None, unless the web API is exposed | Reduces attack surface |
| Healthcheck | `HEALTHCHECK CMD ethos health` | Orchestrator can restart a stuck process |
| Volume for `~/.ethos/` | EBS-backed (or equivalent persistent volume) | Survives container restarts; WAL needs a real filesystem |
| Tmpfs | Mount `/tmp` as tmpfs | Scratch space without persisting to the volume |

Example `docker run`:

```bash
docker run \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp \
  -v /data/ethos:/home/ethos/.ethos \
  --health-cmd="ethos health" \
  --health-interval=30s \
  ethos:latest
```

**Verify:**

```bash
# Inside the container
whoami          # Should NOT be root
touch /bin/test # Should fail (read-only root FS)
```

### 9. Validate bot bindings (multi-bot deployments)

In multi-bot deployments the gateway holds a `Map<botKey, AgentLoop>` -- one loop per configured bot. Each bot binding must point to an existing personality and team.

- Confirm every `botKey` in the config maps to a personality directory under `~/.ethos/personalities/`.
- Confirm each bot's `platform` and `token` pair is correct.
- Confirm `botKey` values are stable across restarts (use the `id:` field in config, or accept the sha256-derived default).

Run the config strict loader to catch dangling references:

```bash
ethos config validate --strict
# Should exit 0 with no warnings about missing personalities or teams.
```

**Verify:** Restart the gateway. Confirm all bots connect and the observability log shows a startup event for each `botKey`.

## Verify

Run the [Verify](../production-hardening-checklist.md#verify) steps on the main page once all parts are done.

## Troubleshoot

See [Troubleshooting](../production-hardening-checklist.md#troubleshooting) on the main page.
