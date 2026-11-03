---
title: Security controls
description: Catalogue of shipped, partial, and planned security controls — channel, tool, filesystem, network, injection, watcher, redaction, install, audit.
kind: reference
audience: shared
slug: security-controls
updated: 2026-11-03
---

Most controls on this page are shipped: code in `packages/` and `extensions/`, tests next to it, and an audit event in `observability.db` where the entry names an audit category. Some are **partial** or **not shipped**, and each entry says so in its status line. Where a control has no enforcer, the entry states that as a limitation rather than as a guarantee.

Where a control has a per-[personality](../getting-started/glossary.md#personality) knob, the entry names it and its default. Controls without a knob are either global or set by the operator in `~/.ethos/config.yaml`, and the entry says which.

The controls fire in the order documented in the [runtime precedence diagram](./overview.md#discussion). If two controls conflict, the earlier one wins.

## Source {#source}

| Layer | Source |
|---|---|
| Channel controls | [`packages/safety/channel/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/channel/src/) |
| Tool boundary | [`packages/core/src/tool-registry.ts`](../../../packages/core/src/tool-registry.ts) |
| Filesystem boundary | [`packages/core/src/scoped/scoped-fs.ts`](../../../packages/core/src/scoped/scoped-fs.ts), [`packages/storage-fs/src/scoped-storage.ts`](../../../packages/storage-fs/src/scoped-storage.ts) |
| Network reach | [`packages/safety/network/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/network/src/), [`packages/core/src/scoped/scoped-fetch.ts`](../../../packages/core/src/scoped/scoped-fetch.ts) |
| Injection defenses | [`packages/safety/injection/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/injection/src/), [`packages/core/src/agent-loop/result-defense.ts`](../../../packages/core/src/agent-loop/result-defense.ts) |
| Watcher | [`packages/safety/watcher/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/watcher/src/) |
| Install scanner | [`packages/safety/scanner/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/scanner/src/) |
| Redaction | [`packages/safety/redact/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/redact/src/) |
| Audit store | [`extensions/observability-sqlite/src/`](https://github.com/ethosagent/ethos/tree/main/extensions/observability-sqlite/src/), categories in [`packages/wiring/src/observability/ethos-observability.ts`](../../../packages/wiring/src/observability/ethos-observability.ts) (`ETHOS_EVENT_CATEGORIES`) |
| Personality schema | [`packages/types/src/personality.ts`](../../../packages/types/src/personality.ts) (`PersonalitySafetyConfig`) |

## Status legend {#status-legend}

| Tag | Meaning |
|---|---|
| *Shipped* | Code lives at the linked path and tests cover it. Where the entry names an audit category, the event lands in `observability.db`. |
| *Partial* | Part of the control is enforced; the entry names the part that is not. |
| *Not shipped* / *Not covered* | No code enforces it today. Documented so you can plan around the gap. |

## Per-personality vs. global {#per-personality-vs-global}

This table shows where each control's policy is set. "Operator" means `~/.ethos/config.yaml`, which applies to the whole deployment.

| Control | Per-personality | Global or operator |
|---|:---:|:---:|
| Channel allowlist + pairing | no | operator, per platform (off for a platform with no `channel_filter` block) |
| Toolset enforcement | yes (`toolset.yaml`) | no |
| Hardline blocklist | no | yes |
| Risk classifier | yes (`approvalMode`) | yes (rules) |
| Filesystem reach | yes (`fs_reach`) | yes (always-deny floor) |
| Network policy | yes (`safety.network`) | yes (SSRF, scheme, cloud-metadata) |
| Provenance wrapping | no | yes |
| Post-read tool downgrade | yes (`enabled`, `turns`, `tools`) | no |
| Watcher rules | no | yes (fixed default rules) |
| Credential redaction | yes (`storeToolArgs`, `storeLlmPayloads`, `redactPatterns`, `blockSecretResults`) | yes (built-in pattern set) |
| Skill / plugin scanner | no | yes (trusted orgs are operator-set) |
| Audit substrate | no | yes (write path); operator retention, with per-personality override |
| Admin panel token auth | no | yes |
| Read-only SQL enforcement | no | yes |
| Desktop remote connection security | no | yes |

The engine is global and the policy is per-personality, so different roles can take different risk postures. A `researcher` personality can list more hosts in `safety.network.allow` than an `engineer` personality without weakening the SSRF or cloud-metadata controls — those apply to both.

## Verifying these controls yourself {#verifying-controls}

Every control above lists a source path. Read the code. Read the tests next to it. Run the test suite:

```bash
pnpm check
```

The tests include adversarial bypass attempts — encoding tricks, redirect chains, symlink chains — not just happy-path verification. If a test fails on your branch, you've found a regression in a control we depend on.

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="channel-level-controls"></a>[Channel-level controls](controls/channel.md#channel-level-controls) | [Security controls: channel-level controls](controls/channel.md) |
| <a id="channel-allowlist"></a>[Channel allowlist](controls/channel.md#channel-allowlist) | [Security controls: channel-level controls](controls/channel.md) |
| <a id="one-time-dm-pairing-codes"></a>[One-time DM pairing codes](controls/channel.md#one-time-dm-pairing-codes) | [Security controls: channel-level controls](controls/channel.md) |
| <a id="mention-gate"></a>[Mention-gate (groups only)](controls/channel.md#mention-gate) | [Security controls: channel-level controls](controls/channel.md) |
| <a id="context-visibility-filter"></a>[Context-visibility filter](controls/channel.md#context-visibility-filter) | [Security controls: channel-level controls](controls/channel.md) |
| <a id="tool-level-controls"></a>[Tool-level controls](controls/tools.md#tool-level-controls) | [Security controls: tool-level controls](controls/tools.md) |
| <a id="per-personality-toolset-enforcement"></a>[Per-personality toolset enforcement](controls/tools.md#per-personality-toolset-enforcement) | [Security controls: tool-level controls](controls/tools.md) |
| <a id="hardline-blocklist"></a>[Hardline blocklist](controls/tools.md#hardline-blocklist) | [Security controls: tool-level controls](controls/tools.md) |
| <a id="risk-classifier"></a>[Risk classifier (mode-aware, per-call)](controls/tools.md#risk-classifier) | [Security controls: tool-level controls](controls/tools.md) |
| <a id="approval-modal"></a>[Approval modal](controls/tools.md#approval-modal) | [Security controls: tool-level controls](controls/tools.md) |
| <a id="filesystem-controls"></a>[Filesystem controls](controls/filesystem.md#filesystem-controls) | [Security controls: filesystem controls](controls/filesystem.md) |
| <a id="scoped-storage-and-boundary-error"></a>[ScopedStorage and BoundaryError](controls/filesystem.md#scoped-storage-and-boundary-error) | [Security controls: filesystem controls](controls/filesystem.md) |
| <a id="symlink-misdirection-handling"></a>[Symlink-misdirection handling](controls/filesystem.md#symlink-misdirection-handling) | [Security controls: filesystem controls](controls/filesystem.md) |
| <a id="bash-filesystem-boundary"></a>[Bash + filesystem boundary](controls/filesystem.md#bash-filesystem-boundary) | [Security controls: filesystem controls](controls/filesystem.md) |
| <a id="network-controls"></a>[Network controls](controls/network.md#network-controls) | [Security controls: network controls](controls/network.md) |
| <a id="per-personality-network-policy"></a>[Per-personality network policy](controls/network.md#per-personality-network-policy) | [Security controls: network controls](controls/network.md) |
| <a id="ssrf-protection"></a>[SSRF protection](controls/network.md#ssrf-protection) | [Security controls: network controls](controls/network.md) |
| <a id="scheme-allowlist"></a>[Scheme allowlist](controls/network.md#scheme-allowlist) | [Security controls: network controls](controls/network.md) |
| <a id="dns-pinning-per-http-client"></a>[DNS pinning per HTTP client](controls/network.md#dns-pinning-per-http-client) | [Security controls: network controls](controls/network.md) |
| <a id="ssrf-browser-proxy"></a>[The browser SSRF guard does not survive an upstream proxy](controls/network.md#ssrf-browser-proxy) | [Security controls: network controls](controls/network.md) |
| <a id="browser-takeover-exposure"></a>[A takeover hands a human the agent's live browser](controls/network.md#browser-takeover-exposure) | [Security controls: network controls](controls/network.md) |
| <a id="prompt-injection-defenses"></a>[Prompt-injection defenses](controls/injection-watcher-redaction.md#prompt-injection-defenses) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="provenance-wrapping"></a>[Provenance wrapping](controls/injection-watcher-redaction.md#provenance-wrapping) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="two-tier-classifier"></a>[Two-tier classifier](controls/injection-watcher-redaction.md#two-tier-classifier) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="post-read-tool-downgrade"></a>[Post-read tool downgrade](controls/injection-watcher-redaction.md#post-read-tool-downgrade) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="memory-injection-scanning"></a>[Memory injection scanning](controls/injection-watcher-redaction.md#memory-injection-scanning) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="watcher"></a>[Watcher](controls/injection-watcher-redaction.md#watcher) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="credential-redaction"></a>[Credential redaction](controls/injection-watcher-redaction.md#credential-redaction) | [Security controls: injection, watcher and redaction](controls/injection-watcher-redaction.md) |
| <a id="skill-and-plugin-install-controls"></a>[Skill and plugin install controls](controls/install.md#skill-and-plugin-install-controls) | [Security controls: skill and plugin install controls](controls/install.md) |
| <a id="static-analysis-pattern-scanner"></a>[Static-analysis pattern scanner](controls/install.md#static-analysis-pattern-scanner) | [Security controls: skill and plugin install controls](controls/install.md) |
| <a id="trust-tiers"></a>[Trust tiers](controls/install.md#trust-tiers) | [Security controls: skill and plugin install controls](controls/install.md) |
| <a id="plugin-capability-grants"></a>[Plugin capability grants](controls/install.md#plugin-capability-grants) | [Security controls: skill and plugin install controls](controls/install.md) |
| <a id="mcp-environment-minimization"></a>[MCP environment minimization](controls/install.md#mcp-environment-minimization) | [Security controls: skill and plugin install controls](controls/install.md) |
| <a id="allowed-skill-permissions"></a>[Allowed skill permissions](controls/install.md#allowed-skill-permissions) | [Security controls: skill and plugin install controls](controls/install.md) |
| <a id="audit-substrate"></a>[Audit substrate — observability.db](controls/audit-and-access.md#audit-substrate) | [Security controls: audit, admin auth and remote access](controls/audit-and-access.md) |
| <a id="cron-output-path-containment"></a>[Cron output path containment](controls/audit-and-access.md#cron-output-path-containment) | [Security controls: audit, admin auth and remote access](controls/audit-and-access.md) |
| <a id="admin-panel-token-auth"></a>[Web dashboard and admin authentication](controls/audit-and-access.md#admin-panel-token-auth) | [Security controls: audit, admin auth and remote access](controls/audit-and-access.md) |
| <a id="read-only-sql"></a>[Read-only plugin data source access](controls/audit-and-access.md#read-only-sql) | [Security controls: audit, admin auth and remote access](controls/audit-and-access.md) |
| <a id="desktop-remote-connection"></a>[Desktop remote connection security](controls/audit-and-access.md#desktop-remote-connection) | [Security controls: audit, admin auth and remote access](controls/audit-and-access.md) |
| <a id="removed-empty-safety-stubs"></a>[Removed empty safety stubs](controls/audit-and-access.md#removed-empty-safety-stubs) | [Security controls: audit, admin auth and remote access](controls/audit-and-access.md) |

## See also {#see-also}

- [What does Ethos guarantee, and what is outside its security boundary?](./security-boundary.md) — which of these controls are published guarantees, and which are not.
- [How does Ethos defend against the threats it knows about?](./overview.md) — the layered model and runtime precedence.
- [What is the threat model?](./threat-model.md) — what each control is defending against.
- [Pre-launch hardening pass](./security-fixes.md) — the issues a pre-launch review surfaced and how each was folded in.
- [Responsible disclosure](./responsible-disclosure.md) — how to report a control bypass.
