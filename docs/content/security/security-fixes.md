---
title: Security hardening log
description: Twenty-two issues surfaced by pre-launch and ongoing security reviews, each entry tagged with status and the source path where the fix landed.
kind: reference
audience: shared
slug: security-fixes
updated: 2026-11-03
---

Most agent frameworks ship the security model first and patch CVEs afterward. Ethos shipped the security model after a deliberate adversarial review — and continues to harden it with each audit pass.

In May 2026, before any of the safety framework was released to customers, the design went through a security review pass focused on the realistic threats in the [Threat model](./threat-model.md). The pass surfaced sixteen issues — gaps, inconsistencies, and bypass paths that would have been bug-bounty material if they had shipped. Every issue was folded into the design before customers saw the framework. Most fixes landed in code at the same time; a few are still being wired in (and are tagged *Partial* or *Planned* below) so the corrected design is visible to customers ahead of the final code landing.

A follow-up audit focused on promptware — malicious instructions embedded in tool output, channel messages, and memory — surfaced six additional hardening items. These are documented in [Promptware defense hardening](#promptware-defense-hardening) below.

## Source {#source}

| Material | Source |
|---|---|
| Schema for `PersonalitySafetyConfig` | [`packages/types/src/personality.ts`](../../../packages/types/src/personality.ts) |
| Field-count gate | [`packages/types/src/__tests__/personality-field-count.test.ts`](../../../packages/types/src/__tests__/personality-field-count.test.ts) |
| Injection defenses | [`packages/safety/injection/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/injection/src/) |
| Network defenses | [`packages/safety/network/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/network/src/) |
| Channel defenses | [`packages/safety/channel/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/channel/src/) |
| Install scanner | [`packages/safety/scanner/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/scanner/src/) |
| Filesystem boundary | [`extensions/tools-file/src/`](https://github.com/ethosagent/ethos/tree/main/extensions/tools-file/src/) |
| Redaction | [`extensions/observability-sqlite/src/redact.ts`](../../../extensions/observability-sqlite/src/redact.ts) |
| PII redaction | [`packages/safety/redact/src/index.ts`](../../../packages/safety/redact/src/index.ts) |
| C2 pattern catalog | [`packages/safety/injection/src/pattern-check.ts`](../../../packages/safety/injection/src/pattern-check.ts) |
| WhatsApp adapter | [`extensions/platform-whatsapp/src/index.ts`](../../../extensions/platform-whatsapp/src/index.ts) |
| Gateway | [`extensions/gateway/src/index.ts`](../../../extensions/gateway/src/index.ts) |

## Status legend {#status-legend}

| Tag | Meaning |
|---|---|
| *Shipped* | Code lives at the linked path; tests cover it. |
| *Partial* | Core path landed; one or more sub-cases (e.g. transport-level integration, config-load gate) still in flight. |
| *Planned* | Interface and design in place; enforcement not yet wired. Documented here so the eventual landing is not a surprise. |
| *Design only* | The fix is a documentation, threat-model, or acceptance-criteria correction. No code change was needed because the gap was about scope or wording, not enforcement. |

The numbering below is the original review order, preserved for traceability with the internal change log.

## What this list is — and isn't {#what-this-list-is}

This list is a record of issues the design caught before shipping. It is not a CVE log. We do not have a CVE log because none of these issues reached customers — they were folded into the design pre-launch.

If a real CVE lands after launch (and we expect some will — defense in depth doesn't mean perfect), it will be tracked separately in the [Responsible disclosure](./responsible-disclosure.md) page with its own advisory format.

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="the-sixteen-fixes"></a>[The sixteen fixes](security-fixes/fixes-1-8.md#the-sixteen-fixes) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="1-unified-audit-substrate"></a>[1. Unified audit substrate](security-fixes/fixes-1-8.md#1-unified-audit-substrate) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="2-approvalmode-off-with-channel-ingress"></a>[2. approvalMode off rejected when channel ingress is present](security-fixes/fixes-1-8.md#2-approvalmode-off-with-channel-ingress) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="3-sandbox-attestation-not-backend-name"></a>[3. Sandbox-relaxes-classifier keyed on capability attestation](security-fixes/fixes-1-8.md#3-sandbox-attestation-not-backend-name) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="4-classifier-no-length-gate"></a>[4. Runtime classifier covers short payloads](security-fixes/fixes-1-8.md#4-classifier-no-length-gate) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="5-redirect-revalidation"></a>[5. Network policy revalidates every redirect hop](security-fixes/fixes-1-8.md#5-redirect-revalidation) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="6-mcp-env-minimization"></a>[6. MCP env minimization removes HOME and sensitive vars](security-fixes/fixes-1-8.md#6-mcp-env-minimization) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="7-pairing-flow"></a>[7. Pairing flow: one-time + sender-bound + nonce-bound + atomic-consume](security-fixes/fixes-1-8.md#7-pairing-flow) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="8-symlink-misdirection"></a>[8. Symlink misdirection + safe non-existent-target handling](security-fixes/fixes-1-8.md#8-symlink-misdirection) | [Security hardening log: fixes 1-8](security-fixes/fixes-1-8.md) |
| <a id="9-bash-requires-attested-backend"></a>[9. bash in toolset requires attested-strict backend at config-load time](security-fixes/fixes-9-16.md#9-bash-requires-attested-backend) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="10-classifier-v1-floor-only"></a>[10. Risk classifier patterns explicitly v1-floor-only](security-fixes/fixes-9-16.md#10-classifier-v1-floor-only) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="11-dns-pinning"></a>[11. DNS pinning per Node HTTP client](security-fixes/fixes-9-16.md#11-dns-pinning) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="12-egress-allowlisting-in-scope"></a>[12. Network egress allowlisting is in scope](security-fixes/fixes-9-16.md#12-egress-allowlisting-in-scope) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="13-supply-chain-wording"></a>[13. Supply-chain wording reconciled](security-fixes/fixes-9-16.md#13-supply-chain-wording) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="14-redaction-wave-0"></a>[14. Credential redaction moved to Wave 0](security-fixes/fixes-9-16.md#14-redaction-wave-0) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="15-schema-change-wave-0"></a>[15. Personality config schema change front-loaded to Wave 0](security-fixes/fixes-9-16.md#15-schema-change-wave-0) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="16-adversarial-test-bar"></a>[16. Adversarial test acceptance bar — every chapter](security-fixes/fixes-9-16.md#16-adversarial-test-bar) | [Security hardening log: fixes 9-16](security-fixes/fixes-9-16.md) |
| <a id="promptware-defense-hardening"></a>[Promptware defense hardening](security-fixes/promptware.md#promptware-defense-hardening) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |
| <a id="17-whatsapp-stranger-rejection"></a>[17. WhatsApp stranger rejection default-on](security-fixes/promptware.md#17-whatsapp-stranger-rejection) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |
| <a id="18-tool-result-delimiters"></a>[18. Tool result delimiter sentinels](security-fixes/promptware.md#18-tool-result-delimiters) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |
| <a id="19-c2-behavioral-patterns"></a>[19. C2/Brainworm behavioral pattern catalog](security-fixes/promptware.md#19-c2-behavioral-patterns) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |
| <a id="20-pii-redaction-gateway"></a>[20. PII redaction at gateway inbound](security-fixes/promptware.md#20-pii-redaction-gateway) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |
| <a id="21-secret-exfiltration-scanning"></a>[21. Secret exfiltration scanning on tool results](security-fixes/promptware.md#21-secret-exfiltration-scanning) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |
| <a id="22-pii-redaction-personality"></a>[22. PII redaction before LLM context](security-fixes/promptware.md#22-pii-redaction-personality) | [Security hardening log: promptware defense hardening](security-fixes/promptware.md) |

## See also {#see-also}

- [What is the threat model?](./threat-model.md) — what each fix is defending against.
- [Security controls](./controls.md) — the catalogue of shipped controls, with source paths for verification.
- [Responsible disclosure](./responsible-disclosure.md) — how to report a new issue.
- [What does Ethos guarantee, and what is outside its security boundary?](./security-boundary.md) — the register that ties each published claim to its enforcement point.
