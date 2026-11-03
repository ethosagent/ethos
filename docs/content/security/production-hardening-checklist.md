---
title: Production hardening checklist
description: Step-by-step checklist for hardening an Ethos deployment before production — secrets, tokens, network, filesystem, observability, and container settings.
kind: how-to
audience: shared
slug: production-hardening-checklist
time: "30 min"
updated: 2026-11-03
---

## Task

Harden an Ethos deployment so every security control documented in [Security controls](./controls.md) is active and verified before the first production message reaches the agent.

## Result

After completing this checklist you will have: secrets out of plaintext config, platform tokens scoped to least privilege, filesystem and network boundaries declared per personality, channel filtering active, injection defenses confirmed, observability writing and redacting, and (if containerised) a locked-down runtime.

## Prerequisites

- A working Ethos installation (`ethos` CLI responds to `ethos --version`).
- At least one personality configured under `~/.ethos/personalities/<id>/`.
- Access to the platform tokens you plan to use (Slack, Telegram, Discord, GitHub, Linear).
- Familiarity with the [threat model](./threat-model.md) and which threats are in scope for your deployment.

## Steps

The steps continue on the subpages below; run them in order.

| Section | Page |
| --- | --- |
| <a id="1-move-secrets-out-of-plaintext-config"></a>[1. Move secrets out of plaintext config](production-hardening-checklist/secrets-filesystem-network.md#1-move-secrets-out-of-plaintext-config) | [Production hardening: secrets, tokens, filesystem and network](production-hardening-checklist/secrets-filesystem-network.md) |
| <a id="2-scope-platform-tokens-to-minimum-privilege"></a>[2. Scope platform tokens to minimum privilege](production-hardening-checklist/secrets-filesystem-network.md#2-scope-platform-tokens-to-minimum-privilege) | [Production hardening: secrets, tokens, filesystem and network](production-hardening-checklist/secrets-filesystem-network.md) |
| <a id="3-declare-filesystem-reach-per-personality"></a>[3. Declare filesystem reach per personality](production-hardening-checklist/secrets-filesystem-network.md#3-declare-filesystem-reach-per-personality) | [Production hardening: secrets, tokens, filesystem and network](production-hardening-checklist/secrets-filesystem-network.md) |
| <a id="4-declare-network-policy-per-personality"></a>[4. Declare network policy per personality](production-hardening-checklist/secrets-filesystem-network.md#4-declare-network-policy-per-personality) | [Production hardening: secrets, tokens, filesystem and network](production-hardening-checklist/secrets-filesystem-network.md) |
| <a id="5-configure-channel-security"></a>[5. Configure channel security](production-hardening-checklist/channels-injection-observability.md#5-configure-channel-security) | [Production hardening: channels, injection, observability and containers](production-hardening-checklist/channels-injection-observability.md) |
| <a id="6-confirm-injection-defenses-are-active"></a>[6. Confirm injection defenses are active](production-hardening-checklist/channels-injection-observability.md#6-confirm-injection-defenses-are-active) | [Production hardening: channels, injection, observability and containers](production-hardening-checklist/channels-injection-observability.md) |
| <a id="7-set-up-observability-and-retention"></a>[7. Set up observability and retention](production-hardening-checklist/channels-injection-observability.md#7-set-up-observability-and-retention) | [Production hardening: channels, injection, observability and containers](production-hardening-checklist/channels-injection-observability.md) |
| <a id="8-harden-the-container-docker-deployments"></a>[8. Harden the container (Docker deployments)](production-hardening-checklist/channels-injection-observability.md#8-harden-the-container-docker-deployments) | [Production hardening: channels, injection, observability and containers](production-hardening-checklist/channels-injection-observability.md) |
| <a id="9-validate-bot-bindings-multi-bot-deployments"></a>[9. Validate bot bindings (multi-bot deployments)](production-hardening-checklist/channels-injection-observability.md#9-validate-bot-bindings-multi-bot-deployments) | [Production hardening: channels, injection, observability and containers](production-hardening-checklist/channels-injection-observability.md) |
| <a id="10-document-backup-and-token-rotation"></a>[10. Document backup and token rotation](production-hardening-checklist/keys-origins-plugins.md#10-document-backup-and-token-rotation) | [Production hardening: API keys, origins and plugin data sources](production-hardening-checklist/keys-origins-plugins.md) |
| <a id="11-scope-api-keys-and-keep-the-admin-panel-off"></a>[11. Scope API keys and keep the admin panel off](production-hardening-checklist/keys-origins-plugins.md#11-scope-api-keys-and-keep-the-admin-panel-off) | [Production hardening: API keys, origins and plugin data sources](production-hardening-checklist/keys-origins-plugins.md) |
| <a id="12-enumerate-the-browser-origins-allowed-to-call-the-web-api"></a>[12. Enumerate the browser origins allowed to call the web API](production-hardening-checklist/keys-origins-plugins.md#12-enumerate-the-browser-origins-allowed-to-call-the-web-api) | [Production hardening: API keys, origins and plugin data sources](production-hardening-checklist/keys-origins-plugins.md) |
| <a id="13-review-plugin-data-source-permissions"></a>[13. Review plugin data source permissions](production-hardening-checklist/keys-origins-plugins.md#13-review-plugin-data-source-permissions) | [Production hardening: API keys, origins and plugin data sources](production-hardening-checklist/keys-origins-plugins.md) |

## Verify

Run the config strict loader to confirm no warnings remain:

```bash
ethos config validate --strict
```

Then run a quick end-to-end smoke test: send a message from a non-allowlisted account and confirm it is dropped. Send a message from an allowlisted account and confirm `observability.db` records the expected `channel.allow`, `audit.tool_call`, and redaction events. Check that no plaintext secrets appear in the audit output:

```bash
sqlite3 ~/.ethos/observability.db \
  "SELECT category, COUNT(*) FROM events GROUP BY category;"
```

If every step above passes, the deployment is hardened.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos secrets list` shows `missing` for a ref | Secret not found in the configured provider | Add the secret to the provider (file, env, or Secrets Manager) |
| `BoundaryError` on a path the personality should reach | `fs_reach` too narrow or symlink resolving outside the allowlist | Widen `fs_reach` to include the resolved real path |
| Agent responds to unknown senders | `channel_filter` not configured or `allowedSenders` empty | Add sender IDs to the allowlist; enable pairing |
| `observability.db` is empty | Database path misconfigured or the process lacks write permission | Check `observability.db` path in config; confirm the process user can write to it |
| Container crashes on startup with read-only FS | `~/.ethos/` not mounted as a writable volume | Mount a persistent volume at the `~/.ethos/` path |
| `ethos config validate --strict` reports missing personality | Bot binding references a personality ID that does not exist | Create the personality directory or fix the `botKey` mapping |
| Web UI returns `401` for every request | No `ethos_auth` cookie, or the session or token it holds is no longer valid | Claimed instance: sign in with username + password, or reset at `/welcome/reset` with the bootstrap token. Unclaimed: open the sign-in URL `ethos serve` prints (`?t=<token>`) again |
| Admin panel returns `403` | `admin.enabled: true` is not set, or the request used an API key | Set `admin.enabled: true` in `config.yaml` and use the web UI; API keys cannot reach admin procedures |
| CORS error in a browser dashboard served from another origin | Its origin is not in `ETHOS_ALLOWED_ORIGINS` (a `*.domain` wildcard does not count for CORS) | Add the exact origin to `ETHOS_ALLOWED_ORIGINS` in the `ethos serve` environment and restart |
| Dashboard query returns data from a write statement | Plugin bypasses `registerDataSource` with direct DB access | Audit plugin code; route all queries through `registerDataSource` |

## See also

- [Security controls](./controls.md) -- the full catalogue of shipped controls.
- [Threat model](./threat-model.md) -- what Ethos defends against and what is out of scope.
- [How does Ethos defend against the threats it knows about?](./overview.md) -- the layered model and runtime precedence.
- [Pre-launch hardening pass](./security-fixes.md) -- sixteen issues surfaced and fixed before shipping.
- [Least-privilege tokens](./least-privilege-tokens.md) -- per-platform scope tables.
- [Bot token rotation playbook](./bot-token-rotation-playbook.md) -- step-by-step rotation procedure.
- [Why should agents never hold database credentials?](./api-mediated-access.md) -- reference architecture for API-mediated data access.
- [Why run one process per personality in production?](./process-isolation.md) -- when to split from shared-process to one-pod-per-personality.
