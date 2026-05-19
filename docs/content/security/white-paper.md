---
title: Why is Ethos's security model built on shared responsibility?
description: Ethos's customer-facing security narrative — shared responsibility, the personality boundary, request lifecycle, and deployment shapes.
kind: explanation
audience: shared
slug: white-paper
updated: 2026-05-19
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

## 4. How Ethos protects every request

Every inbound message — whether from Slack, Telegram, Discord, WhatsApp, email, the web dashboard, or the CLI — flows through the same sequence of gates before it reaches the model, and the same sequence again on the way back. The gates are mechanical, present-tense, and ordered.

**Inbound message arrives at the channel adapter.** The adapter wraps the raw platform message in a typed `InboundMessage` carrying a stable `botKey` derived from the credentials the adapter was constructed with. In multi-bot deployments, `botKey` is what later routes the message to the right per-bot agent loop.

**Sender allowlist check.** The channel filter applies a per-channel sender allowlist. Messages from senders outside the allowlist are dropped before any model invocation. For platforms with a pairing flow (Telegram, Slack, Discord), an unknown sender can be allowlisted via a one-time pairing code presented out of band.

**Mention and reply gate.** In group channels, the message must address the bot directly — by mention, by reply to a bot message, or by being a direct message — for the framework to engage. Off-topic group chatter never enters the agent loop.

**Context-visibility filter.** When the inbound message quotes or includes context from other senders, content from non-allowlisted senders is stripped. A stranger quoted by an allowed user cannot poison context by being quoted.

**Per-bot routing.** The gateway holds a map of `botKey` to agent loop. The message is dispatched to the right loop — one personality per bot, isolated session lanes, no cross-bot leakage.

**Personality loading.** The agent loop loads the personality's declared toolset, filesystem reach, network policy, memory scope, and plugin allowlist. All five govern the rest of the request.

**Inbound safety injection.** The text passes through the injection pipeline before reaching the model. Chat-template tokens are sanitized. Content from external or untrusted sources is wrapped in `<untrusted>` blocks with explicit provenance, so the model can syntactically distinguish data from instructions. The defense preamble (a fixed system-prompt fragment that teaches the model how to treat `<untrusted>` content) is injected. This pipeline runs on every inbound user message and every retrieved memory entry — there is no opt-out.

**Memory prefetch.** Memory is read only within the personality's scope. Personality-scoped memory cannot leak across personalities; team-scoped memory is shared only among members of the same team.

**System prompt assembly.** Personality identity, scoped memory, defense preamble, and team memory index (for team-bound personalities) are composed into the system prompt for this turn.

**Toolset filter at definition time.** The model sees only tool definitions that are in the personality's toolset. The forbidden tools are not present in the API call.

**Model invocation.** The provider call goes out. The framework supports Anthropic and OpenAI-compatible providers (OpenRouter, Ollama, Gemini, vLLM).

**Tool-call authorization.** If the model returns tool calls, each call is checked against the toolset allowlist a second time at execution. Calls outside the allowlist are rejected with a typed error result; the rejection preserves the provider's strict tool-use / tool-result pairing contract.

**Before-tool-call hooks.** The terminal hardline guard rejects dangerous shell forms (rm of system paths, fork bombs, curl-to-shell) regardless of approval mode. The process-spawn guard applies a parallel hardline blocklist to direct process spawning. Capability hooks verify the tool has the capabilities it declared.

**Capability-scoped execution.** Tools execute inside a `ToolContext` that exposes only the capabilities the tool declared at registration — filesystem, network, secrets, storage, process. A tool that declared `fs.read` cannot suddenly open a socket; the socket capability is simply not present in its context.

**Output sanitization and post-read downgrade.** Tool results from sources whose output is untrusted (web fetches, MCP retrievals, retrieved emails) are sanitized and wrapped in `<untrusted>` blocks on the way back. After a tool read from an untrusted source, a one-turn downgrade window removes dangerous tools (write_file, bash, network-egress tools) from the next turn's allowlist — so a successful injection in retrieved content cannot immediately exfiltrate.

**Result budget enforcement.** Each tool result is truncated to a per-call character budget split from a turn-level budget cap. Oversized results carry a clearly-marked truncation suffix. The model cannot be flooded into ignoring the user's request by a tool that returns a megabyte of content.

**Outbound deduplication.** When the model produces a final response, it passes through a centralized outbound dedup chokepoint keyed on `(sessionId, sha256(content))` with a configurable TTL. Streaming-finalization races, retries, and adapter quirks cannot produce double-sends. This is the single dedup chokepoint — adapters do not roll their own.

**Adapter dispatch.** The adapter sends the response. Tool-progress events default to internal audience (logs and telemetry only); promotion to user-facing requires explicit per-event opt-in by the tool author. Intermediate state cannot leak to user-facing channels by default.

Every gate is mechanical. Skipping any one of them is either a bug that surfaces as a boundary error, or a refactor that requires an explicit constitutional amendment.

---

## 5. The eight Safety Constitution commitments

These are the commitments Ethos makes to operators about what the framework will always do. They have no override flag. Amendments follow a documented process.

**Tool allowlist is authoritative.** The personality's declared toolset is the sole authority on what the model may invoke. Enforcement happens both at definition time (the model sees only allowed tools) and at execution time (the registry rejects disallowed calls). There is no flag that disables this.

**Sandbox attestation is binding.** Any tool that executes untrusted code (a sandbox runner, a plugin host, a code interpreter) must declare a sandbox attestation describing its confinement properties. A tool that fails or omits the attestation falls under the strictest tool classifier — its calls are treated as untrusted. The attestation contract prevents a plugin that *claims* it sandboxes user code from being trusted on its word.

**Outbound deduplication is centralized.** All outbound channel messages flow through one chokepoint with content-hash keying and a TTL window. Adapter-local dedup is forbidden. Duplicates are silently dropped. This prevents both accidental double-sends and the use of retry behaviour to infer agent state.

**Tool progress is internal by default.** Tool-progress events default to internal audience — consumed by logs, telemetry, and the developer TUI. Promotion to user-facing requires per-event explicit opt-in by the tool author. The framework never promotes a progress event on the tool's behalf. Sensitive intermediate state cannot leak to user-facing channels by accident.

**Hooks enforce, not observe.** A hook that asserts a precondition must use the modifier or claimer execution model — the models that can actually prevent the gated action. Observation-only is the parallel model and is intended for side effects only. The hook registry distinguishes the three models at the type level so a hook author cannot accidentally write a non-blocking enforcement check.

**Inbound safety injection is universal.** Every inbound user message and every retrieved memory passes through the safety injection pipeline before reaching the model. Chat-template tokens are sanitized; untrusted content is provenance-wrapped; the defense preamble is injected. There is no opt-out.

**Boundary errors are user-facing.** Every framework boundary violation — toolset rejection, storage scope violation, sandbox attestation failure, secrets-scope violation — surfaces as a typed error to the operator. Silent failure is forbidden. Silent disablement of a control is the worst class of security bug; the framework refuses to enable it.

**Plugin contract compatibility is strict.** Plugins declare the contract major version they were built against. The loader rejects mismatches without overlap. A plugin built against an older safety contract cannot run in a current process.

A pull request that softens, removes, or routes around any of these commitments is rejected at review. They are amended through the constitutional process or not at all.

---

## 6. Defenses by category

**Personality and permission boundary.** A personality declares its toolset, capabilities, filesystem reach, network policy, MCP server allowlist, and plugin allowlist as named fields in a frozen schema. The framework enforces every field structurally. A skill bundled into a personality cannot bring a tool the host personality did not declare — skills are filtered through the personality's capability set. Memory is scope-bound by personality unless the personality is a team member, in which case shared topic files are addressable under the team scope.

**Prompt injection defenses.** Provenance wrapping puts every piece of external or untrusted content (channel messages, retrieved memory, tool output from external sources) inside `<untrusted>` blocks with origin labels. Chat-template tokens (the special tokens model providers use to structure conversations) are sanitized out of inbound content before it reaches the model. The defense preamble — a fixed fragment in the system prompt — teaches the model how to interpret `<untrusted>` blocks. A heuristic structured-pattern check flags content that looks like an instruction-injection attempt. After a tool read from an untrusted source, a post-read downgrade window removes dangerous tools from the next turn's allowlist for one turn, so a successful injection in retrieved content cannot immediately exfiltrate.

**Network egress controls.** The framework's `safeFetch` is the only HTTP client used by built-in tools. It applies a non-overridable cloud-metadata block (the IMDSv2 endpoint, GCP metadata, Azure IMDS), a default-deny stance for private IP ranges (RFC1918, loopback, link-local) that personalities can explicitly opt into, scheme pinning (`https://` only by default for outbound), and `Authorization` header stripping on cross-origin redirects. Per-personality host allowlists in `safety.network` further restrict which destinations a personality can reach.

**Channel security.** Each channel adapter is constructed with credentials that derive a stable `botKey`; every inbound message is stamped with that key for routing. Sender allowlists drop messages from unrecognized accounts. One-time pairing flows let new senders prove control of an out-of-band channel before being added to the allowlist. Mention gating ensures the bot engages only when addressed in group contexts. Context-visibility filtering strips quoted content from non-allowlisted senders. Outbound deduplication is centralized at the gateway.

**Tool execution guards.** The terminal hardline blocklist refuses dangerous shell forms — `rm -rf` against root or HOME, fork bombs, curl-to-shell pipes, sudo escalations — regardless of approval mode or operator override. The process-spawn hardline applies the same blocklist to direct process spawning, so escaping the terminal tool by spawning `bash -c` does not bypass the guard. The before-tool-call hook contract lets the framework or operator-provided hooks block any tool call before it executes; the hook's verdict is binding, not advisory. Per-tool result budgets prevent flooding. The audience boundary on progress events keeps internal state from leaking to user channels.

**Secrets management.** The `SecretsResolver` interface is the seam. Built-in backends ship for files (`FileSecretsResolver`, with strict POSIX permissions — `0o600` per secret, `0o700` on the parent directory, re-applied on every write), environment variables (`EnvSecretsResolver`, used for tokens supplied at startup), and AWS Secrets Manager (`AwsSecretsResolver`, for cloud deployments). A `MergedSecretsResolver` lets operators layer sources without code change — environment for one token, AWS for another, file for local development. A `ScopedSecretsResolver` decorator can further narrow which secrets a tool's context can resolve, so a tool granted access to `slack.bot.token` cannot also fetch `aws.admin.key`. Credentials are redacted from logs and observability before persistence.

See [Why is Ethos's secrets architecture shaped this way?](https://ethosagent.ai/docs/using/explanation/secrets-architecture) and [Configure AWS Secrets Manager](https://ethosagent.ai/docs/using/how-to/configure-aws-secrets).

**Filesystem isolation.** All reads and writes under `~/.ethos/` go through the storage interface. `ScopedStorage` decorates that interface with per-personality read and write prefix allowlists and a universal always-deny floor for sensitive paths (`~/.ssh`, `~/.aws`, system keychains, browser stores). Each personality has its own data directory under `~/.ethos/personalities/<id>/` which is the default write target. New code that needs to touch `~/.ethos/` is required to take the storage interface as a constructor dependency — direct filesystem imports for that path tree are blocked at review.

**Memory model.** Memory is a human-curated store, not an agent-autofilled one. The two default keys for personality scope are `MEMORY.md` (rolling project context) and `USER.md` (persistent user profile). Team scope adds an arbitrary topic set — one markdown file per topic. The memory tools (`memory_read`, `memory_write`, `session_search`, and the team equivalents) are themselves gated by toolset; a personality without `memory` in its toolset cannot read or write memory.

**Plugin and supply-chain safety.** Plugins go through an install-time scanner that walks entrypoints for suspicious shapes — eval, dynamic imports of network or process modules, hardcoded secrets, unexpected network connections. Plugins fall into trust tiers: builtin, trusted-repo, community, and untrusted. The personality's plugin allowlist controls which tier is acceptable. Plugin contract version checking is strict (commitment 8). MCP server environment variables are minimized — the framework passes only the variables explicitly declared in the MCP server config.

**Audit and observability.** Every agent event, tool call, tool result, and outbound message is recorded in the observability database with traces, spans, and structured events. Redaction patterns strip known credential shapes before content lands in the audit store. Retention policies are configurable per-deployment. The session log is searchable with full-text indexing (FTS5) so an operator can replay any session end-to-end. Personality-level redaction settings let high-stakes personalities apply additional masking before persistence.

**Web and API surface.** The optional web API uses bearer-token authentication for programmatic clients and dual-auth (bearer or cookie) for the dashboard. The admin namespace requires cookie-based authentication exclusively, refusing bearer tokens — so an exfiltrated API token cannot reach admin endpoints. CORS origins are restricted by configuration. Session cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`. CSRF protection is enforced on state-changing requests via a synchronizer token bound to the session. Per-route rate limiting is applied where it matters most — the bearer-auth endpoint, attachment uploads, and pairing-code generation — so brute-force and abuse paths face an enforced ceiling before they reach application logic.

**Watcher and budget controls.** A per-personality watcher tracks activity rates — tool calls per minute, model invocations per hour, outbound messages per session — and rate-limits the personality when configured thresholds are exceeded. Per-personality `budgetCapUsd` bounds total spend on model calls within a configurable window, so a runaway loop in one personality cannot drain the operator's account or denial-of-service the other personalities.

---

## 7. Customer responsibilities (the other half of the shared model)

Ethos's controls are the inner ring. The outer ring is yours. Each item below names a control that the deploying environment must provide, why Ethos cannot provide it, and what we recommend.

**Process isolation.** Ethos runs as a Node process. If the process is compromised — through a vulnerable native dependency, an unsafe plugin, or an OS-level exploit — the attacker reaches the agent's entire process environment. Ethos's guards bound *what the agent does*; they do not bound *what an attacker who has compromised the process can do*. Run Ethos in a container (Docker with `--init` for proper PID 1 reaping, a restricted non-root user, `--read-only` root filesystem, dropped Linux capabilities) or a VM. For higher-stakes deployments, run per-personality containers, or use a sandboxed runtime such as Firecracker or gVisor for stronger process boundaries. See [Why run one process per personality in production?](https://ethosagent.ai/docs/security/process-isolation) and [Deploy Ethos in production](https://ethosagent.ai/docs/using/how-to/deploy-in-production).

**Network controls.** Ethos's `safety.network` enforcement is the inner ring of egress control. The outer ring belongs to your network layer: VPC routing, NAT egress allowlists, security groups, host-level iptables or nftables rules, or a forward proxy that mirrors the per-personality allowlist. The framework's enforcement is fail-open at the OS level — a bug in the egress check is "egress is open." A network-layer mirror of the same allowlist closes that gap. For production deployments, restrict inbound traffic (web API, gateway) behind a reverse proxy that terminates TLS and enforces rate limits; restrict outbound traffic through a NAT gateway or proxy that allowlists destination hosts.

**Production database access.** Do not give Ethos direct production database credentials. Even with Ethos's controls in place, a database credential's blast radius is enormous, its scope is hard to narrow, and rotating it requires coordinating with every consumer. The recommended pattern is API-mediated access: expose a controlled internal API with its own authentication, authorization, rate limiting, and audit log, and give the agent a narrowly-scoped token to that API. The agent's audit trail and the API's audit trail compose into a defensible posture; the database credential never leaves your service mesh. See [Why should agents never hold database credentials?](https://ethosagent.ai/docs/security/api-mediated-access).

**Encryption at rest and credential management.** The host volume that holds `~/.ethos/` must be encrypted: EBS-encrypted volumes on AWS, FileVault on macOS, LUKS on Linux. POSIX permission bits (`chmod 0o600`) are a kernel hint, not a kernel-level secret — they protect against unprivileged users on the same host but not against root or against disk theft. For production AWS deployments, use AWS Secrets Manager (Ethos supports it natively): credentials live in the secrets manager, IAM controls access, CloudTrail audits every fetch. The IAM role's policy should grant `secretsmanager:GetSecretValue` only and scope the `Resource` ARN to a path prefix specific to this deployment (for example, `arn:aws:secretsmanager:<region>:<acct>:secret:ethos/prod/*`). Decryption permissions on the AWS-managed KMS key follow the same scoping. See [AWS IAM policies reference](https://ethosagent.ai/docs/using/reference/aws-iam-policies) for the minimum policy Ethos needs.

**Credential rotation policy and cadence.** Bot tokens, API keys, OAuth refresh tokens — all of them rotate. Ethos provides the resolver indirection that makes rotation safe (consumers reference secrets by name, not value), but the rotation cadence and the integration with your identity provider is yours. For Slack, Telegram, Discord, GitHub, and Linear, see [Least-privilege token cookbook](https://ethosagent.ai/docs/security/least-privilege-tokens) for the minimum scope each token needs.

**Monitoring and alerting.** Ethos's observability database records what the agent did — every tool call, every channel message, every safety event. Wire that audit stream into your existing monitoring stack (Splunk, Datadog, CloudWatch, Honeycomb) so anomalies trigger your standard incident response. Useful alarms: high tool-call rate per session, denied access attempts above a threshold, secret-fetch volume from an unexpected principal, sustained model-cost spikes per personality, and any non-Ethos IAM principal reading a secret from the deployment's prefix. Boundary errors (toolset rejections, storage scope violations, sandbox attestation failures) are typed and labelled in the audit stream — alarm on rate-of-change rather than absolute count, since a small steady rate is normal and represents the controls doing their job.

**Host OS patching and runtime updates.** The Node runtime, the container base image, the host OS — all need patching on your normal cadence. Ethos pins minimum versions for the runtime but does not orchestrate the upgrade.

**Backup and recovery.** `~/.ethos/` holds your configuration, secrets references, personalities, skills, session history, memory, kanban state, and cron jobs. Back it up like any other production state. The observability database is append-only and can be rotated by retention policy; the rest is small enough to snapshot frequently.

**Identity and access management.** Who can SSH to the host? Who can read `~/.ethos/secrets/`? Who can deploy new personalities or modify existing ones? These are organizational policies Ethos cannot enforce; they belong in your IAM, your secrets management, and your deployment pipeline. For AWS deployments, see [AWS IAM policies reference](https://ethosagent.ai/docs/using/reference/aws-iam-policies) for the minimum IAM scope Ethos needs.

---

## 8. Recommended deployment shapes

Pick the row that matches your stakes. Each row is a complete posture; the controls compose.

**Solo or homelab (single operator, single machine, low stakes).** File-backed secrets are appropriate — `~/.ethos/secrets/` with strict POSIX permissions on a single-user host is the model the framework was originally tuned for. Default `fs_reach`. Personality `toolset` opt-in per personality. Process isolation is unnecessary. Approval mode `smart` for dangerous tools — the framework prompts on first use of each tool and remembers the answer per session. No AWS Secrets Manager.

**Small team or shared mini-PC.** Same as solo, plus: channel filter and pairing enabled for any external channels; per-channel sender allowlist enforced; approval mode `manual` for any tool that mutates external state; `safety.network` enforced for outbound HTTP with personality-specific allowlists; memory in `per-personality` mode (the default). Run as a non-root user; if the host is shared with other services, run Ethos inside a Docker container with a restricted user. The [production hardening checklist](https://ethosagent.ai/docs/security/production-hardening-checklist) covers each item in order.

**Production or regulated environment (cloud, multi-personality).** Use `AwsSecretsResolver` for all credentials, with an IAM role scoped to a specific `ethos/*` secret prefix and `secretsmanager:GetSecretValue` only. Run inside a container with a non-root user, `--read-only` root filesystem, restricted CPU and memory, and Linux capabilities dropped (`--cap-drop=ALL`, then add only `NET_BIND_SERVICE` if the container needs to bind ports under 1024). Mount `~/.ethos/` as a named volume backed by an encrypted EBS volume; mount the rest of the filesystem read-only. Put the web API behind a reverse proxy that terminates TLS and enforces global rate limits — the framework's per-route limits are the inner ring; the proxy's global limits are the outer ring. Restrict outbound traffic through a NAT gateway or egress proxy that mirrors the personality network allowlist at the VPC layer. Wire the observability database into your monitoring stack. Set a CloudTrail alarm on any non-Ethos principal that reads `ethos/*` secrets. Set observability retention per regulatory requirement. Configure approval mode `manual` for any tool that mutates external state in the production tenant.

**High-stakes or third-party data.** Run one container per personality so a compromise of one personality's runtime is contained to that personality's process. Use a sandboxed runtime (Firecracker, gVisor, per-personality VMs) for the strongest isolation. Approval mode `manual` for all side-effect tools. Per-personality network egress allowlist enforced inside the framework and mirrored at the VPC and host firewall layers. Plugins restricted to the `builtin` and `trusted-repo` tiers; no `community` or `untrusted` plugins. Tokens scoped at the source — GitHub fine-grained PATs, Linear app-scope tokens, AWS IAM session policies that further narrow the role's effective permissions. Pre-deploy review for every new personality, including a dry-run period before any side-effect tools are enabled. Personality-level redaction policies applied so high-stakes content cannot land in observability without masking. Audit-stream retention set to the maximum your regulatory regime allows, with offline archival of older content to an immutable store.

For the step-by-step checklist mapping each control to an operator action, see [Production hardening checklist](https://ethosagent.ai/docs/security/production-hardening-checklist).

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
