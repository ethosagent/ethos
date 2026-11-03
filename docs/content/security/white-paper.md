---
title: Why is Ethos's security model built on shared responsibility?
description: Ethos's customer-facing security narrative — shared responsibility, the personality boundary, request lifecycle, and deployment shapes.
kind: explanation
audience: shared
slug: white-paper
updated: 2026-11-03
---

# Ethos Security White Paper

> Last reviewed: 2026-05-19.
> Audience: security teams, operators evaluating Ethos for production, contributors.

---

## 1. Executive summary

Ethos is built on a **shared responsibility model**. Ethos owns the layers that govern agent behaviour — what tools an agent may call, what files it may touch, what hosts it may reach, what content reaches the model, and what gets recorded for audit. The deploying organization owns the layers below the agent process — operating-system isolation, network controls at the VPC and firewall layer, host-disk encryption, credential rotation, monitoring, and identity management. The two sets of controls compose into a defensible posture; neither layer is sufficient alone, and Ethos's design is explicit about which is which.

Ethos is a TypeScript framework for building production AI agents that persist state, drive tools, talk to channels, and route work between personalities. The framework's central security primitive is the **personality** — a schema-bound architectural component, not a system prompt. A personality's declared toolset, filesystem reach, network policy, plugin allowlist, and memory scope structurally determine what the agent can do at the framework layer, *before* any prompt reaches the model. There is no "ignore previous instructions" path because the gates are not in the prompt.

Eight Safety Constitution commitments are non-optional and have no override flag. They cover tool authority, sandbox attestation, outbound deduplication, audience boundaries on tool progress, hook semantics, inbound safety injection, surfaced boundary errors, and strict plugin contract versioning. They are amended through a documented constitutional process or not at all — a pull request that softens any of them is rejected at review.

This document describes the controls Ethos ships today, the responsibilities it expects of the deploying environment, and the supported deployment shapes. It is meant to be read end-to-end by a security team evaluating Ethos for production, and reread by reference once a deployment is live. It is current as of the date above; the controls described here are present in the current release and exercised in test.

Where claims need more depth, this paper links to the public docs site, which is the canonical reference for configuration. The three orienting pages are:

- [Security overview](https://ethosagent.ai/docs/security/overview) — the layered defense model.
- [Threat model](https://ethosagent.ai/docs/security/threat-model) — what's in scope and what's not.
- [What is Ethos?](https://ethosagent.ai/docs/getting-started/what-is-ethos) — the framework's broader design intent for readers new to the product.

---

## 2. Shared responsibility model

Security in any agent system is layered. The single most important question for an evaluating team is: *which layer owns which control?* Ethos's answer is explicit.

Ethos owns everything that runs inside the agent process: the agent loop, tool dispatch and authorization, memory routing, channel filtering, inbound and outbound message hygiene, plugin loading, secrets resolution, and the audit trail. The deploying organization owns everything around the process: the operating system, the network, the disk, the credential lifecycle, and the people with access. The split is designed so that each layer's controls reinforce the other — Ethos's per-personality network allowlist is the inner ring; the customer's VPC and firewall rules are the outer ring. Defense in depth is the point.

| Layer | Ethos owns | Customer owns |
|---|---|---|
| Agent loop, tool execution, memory routing | ✓ | |
| Personality boundary enforcement (toolset, fs_reach, network policy, memory scope, plugin allowlist) | ✓ | |
| Prompt-injection defenses (provenance wrapping, sanitization, defense preamble, post-read tool downgrade) | ✓ | |
| Secrets resolver architecture and built-in backends (file, env, AWS Secrets Manager) | ✓ | |
| Audit trail and observability (session log, traces, redaction, retention) | ✓ | |
| Hardline tool guards (terminal blocklist, process-spawn blocklist) | ✓ | |
| Channel security (sender allowlists, one-time pairing, mention gating, outbound dedup) | ✓ | |
| Operating-system process isolation (containers, VMs, sandboxed runtimes) | | ✓ |
| Network-level controls (firewall, VPC, security groups, egress proxies) | | ✓ |
| Encryption at rest of host disk | | ✓ |
| Production database access patterns (API-mediated wrapping) | | ✓ |
| Credential rotation policy and cadence | | ✓ |
| Monitoring and alerting on host and network infrastructure | | ✓ |
| Host OS patching and runtime updates | | ✓ |
| Backup and recovery of `~/.ethos/` state | | ✓ |
| Identity management (machine access, SSH keys, IAM principals) | | ✓ |

The boundary is crisp: Ethos protects what its process owns. The deploying environment protects everything around the process. Section 7 covers the customer-owned side in detail with concrete recommendations.

---

## 3. The personality boundary — a structural security primitive

A personality in Ethos is not a system prompt with a name. It is a frozen, schema-bound architectural component whose declared fields determine what the framework will honour. The schema is locked: adding or renaming a top-level field requires explicit constitutional amendment, two-maintainer approval, and a mechanical field-count CI gate that fails if the count drifts. This rigidity is the point. A personality is more like a process manifest than a configuration string.

**There is no system-prompt instruction to ignore because the gates are not in the prompt.** Five declared fields do the load-bearing work:

**Toolset is authoritative.** The personality's toolset is the sole authority on what the model may invoke. Enforcement happens at two layers: at definition time, the model receives tool definitions only for tools in the allowlist; at execution time, the tool registry rejects any out-of-allowlist call with a typed error block that preserves the model-provider message contract. A personality without `bash` in its toolset cannot reach `bash` no matter how its context is poisoned — the tool's definition is not even passed to the model.

**Filesystem reach is bounded by fs_reach.** Every read and write to `~/.ethos/` and the working directory flows through the storage interface decorated with per-personality read and write allowlists. A researcher personality's `read_file` cannot peek at an engineer's `MEMORY.md`. Defaults are conservative — a personality only sees its own data directory, its skills, and the current working directory. A universal always-deny floor blocks access to `~/.ssh`, `~/.aws`, and similar sensitive paths regardless of allowlist configuration.

**Network egress is bounded by safety.network.** Each personality declares an allow and deny list for outbound HTTP hosts. Cloud-metadata endpoints (`169.254.169.254`, `metadata.google.internal`, and the documented variants) cannot be overridden — they are denied even when private-URL access is explicitly enabled. Private network ranges (RFC1918, loopback, link-local) are denied by default; the personality must explicitly opt in to reach them.

**MCP servers and plugins are explicit opt-in.** A personality's `mcp_servers` and `plugins` fields are allowlists, not configuration. Empty or missing means dormant: an installed plugin whose ID is not in the personality's list does not load its tools, hooks, or injectors for that personality. The system fails closed.

**Memory scope is per-personality by default.** The engineer personality cannot read the researcher personality's `MEMORY.md`. Team memory is a distinct, opt-in scope that the team's member personalities share. Scope is bound at construction; a memory provider routes reads and writes by opaque scope identifier.

Personality is the unit. The framework guarantees that an "engineer" personality's runtime composition — prompt, tools, filesystem reach, network policy, model routing, memory scope — atomically swaps as a coherent whole when the operator picks that personality. There is no half-applied state.

See [Why is personality the unit, not a system prompt?](https://ethosagent.ai/docs/using/explanation/what-is-a-personality) for the design rationale.

---

## Subpages

| Section | Page |
| --- | --- |
| <a id="4-how-ethos-protects-every-request"></a>[4. How Ethos protects every request](white-paper/request-protection.md#4-how-ethos-protects-every-request) | [How does Ethos protect every request, and what does it commit to?](white-paper/request-protection.md) |
| <a id="5-the-eight-safety-constitution-commitments"></a>[5. The eight Safety Constitution commitments](white-paper/request-protection.md#5-the-eight-safety-constitution-commitments) | [How does Ethos protect every request, and what does it commit to?](white-paper/request-protection.md) |
| <a id="6-defenses-by-category"></a>[6. Defenses by category](white-paper/defenses-and-responsibilities.md#6-defenses-by-category) | [Which defenses does Ethos ship, and what do customers still own?](white-paper/defenses-and-responsibilities.md) |
| <a id="7-customer-responsibilities-the-other-half-of-the-shared-model"></a>[7. Customer responsibilities (the other half of the shared model)](white-paper/defenses-and-responsibilities.md#7-customer-responsibilities-the-other-half-of-the-shared-model) | [Which defenses does Ethos ship, and what do customers still own?](white-paper/defenses-and-responsibilities.md) |
| <a id="8-recommended-deployment-shapes"></a>[8. Recommended deployment shapes](white-paper/defenses-and-responsibilities.md#8-recommended-deployment-shapes) | [Which defenses does Ethos ship, and what do customers still own?](white-paper/defenses-and-responsibilities.md) |

---

## 9. Reporting a vulnerability

Use GitHub's private vulnerability reporting — the "Report a vulnerability" button on this repository's Security tab. We aim to acknowledge within five business days and follow 90-day coordinated disclosure with a fix-or-ETA acknowledgement.

In scope: the `ethos` CLI, web dashboard, gateway adapters, bundled extensions under `extensions/`, and documented public APIs.

Out of scope: user-installed plugins, MCP servers, or skills (report to those projects); issues only reproducible with experimental flags or with safety controls explicitly disabled.

For the full disclosure policy, see [Responsible disclosure](https://ethosagent.ai/docs/security/responsible-disclosure).

---

## Appendix: Quick reference — common customer concerns

| Concern | How Ethos addresses it | Customer responsibility |
|---|---|---|
| The agent could do something harmful on its own | Personality `toolset` is authoritative; terminal hardline blocklist refuses dangerous shell forms regardless of approval mode; per-personality budget caps bound runaway-loop spend; watcher rate-limits per-personality activity | Start every new personality with the smallest plausible toolset and grow it. Run new personalities in approval mode `manual` before promoting. |
| Tool permissions are too broad | Personality `toolset`, `mcp_servers`, and `plugins` are explicit allowlists; missing or empty means dormant; skills are capability-filtered against the host personality | Choose the most specific toolset possible. Prefer scoped tools over `bash` plus a CLI. |
| Token scopes are too wide for what the agent needs | `SecretsResolver` indirection means personalities reference tokens by name, not value; per-MCP-server allowlist; ScopedSecretsResolver narrows tool-level access | Mint the narrowest token at the source — GitHub fine-grained PATs, Linear app scopes, AWS session policies — and store the narrow token in the resolver. |
| Production credentials in an agent are unsafe | Architecture supports the API-mediated pattern; observability records every tool call and outbound message; tool capability framework lets HTTP tools be wrapped as personality-specific without granting bash | Build the controlled API; restrict the agent to the API token; never store production database credentials in the resolver. |
| Inbound content from channels can poison context | Universal inbound safety injection: chat-template-token sanitization, provenance wrapping, defense preamble, post-read downgrade; channel context-visibility filter strips quoted content from non-allowlisted senders | Keep personality toolsets narrow so a successful injection has small blast radius. Run high-stakes personalities in approval mode `manual`. |
| External channel connections create risk even without exposed ports | Sender allowlist plus one-time pairing controls who can reach the agent; per-bot routing keyed on `botKey` isolates channels at the framework layer; centralized outbound dedup prevents replay flooding | Rotate channel tokens on a schedule; restrict channel access to known accounts; put inbound web API behind a reverse proxy with rate limits. |
| Filesystem secrets storage is a concern for production | `FileSecretsResolver` enforces strict POSIX permissions; `AwsSecretsResolver` ships as the drop-in production backend; `MergedSecretsResolver` layers sources; `ScopedSecretsResolver` narrows tool-level access | Use AWS Secrets Manager for production; encrypt the disk; do not run on shared multi-user hosts. |
| Secrets could leak through agent memory or state | Redaction patterns strip known credential shapes before persistence; per-personality memory scope contains leaks within a personality; ScopedStorage enforces write boundaries | Hand tools opaque secret references, not values, through the resolver; use read-only API tokens whenever possible. |
| Runtime isolation on a bare host is insufficient | Sandbox-attestation contract requires tools running untrusted code to declare their confinement; failed attestation forces strictest classifier | Run Ethos in a container or VM; for high-stakes deployments, per-personality containers or a sandboxed runtime (Firecracker, gVisor). |
| Network controls need stronger guarantees | `safety.network` per-personality allow and deny lists; `safeFetch` SSRF gate with non-overridable cloud-metadata block, default-deny private ranges, scheme pinning, cross-origin Authorization stripping | Mirror the personality network allowlist at the VPC, NAT, or forward-proxy layer so the framework is not the only enforcement point. |
| API-mediated access needs auditing on both sides | Observability subsystem records every agent event, tool call, and outbound message with structured traces and redaction | Your API also needs an audit log; compose Ethos's audit trail with your API's audit trail. |
