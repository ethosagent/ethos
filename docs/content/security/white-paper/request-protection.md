---
title: "How does Ethos protect every request, and what does it commit to?"
description: "Request lifecycle protections and the eight Safety Constitution commitments."
kind: explanation
audience: shared
updated: 2026-11-03
---

## Context

The per-request protection path and the eight Safety Constitution commitments. Part of [Why is Ethos's security model built on shared responsibility?](../white-paper.md).

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

**Outbound deduplication.** When the model produces a final response, it passes through a centralized outbound dedup chokepoint keyed on `(sessionId, sha256(content))` and the inbound message it answers, with a configurable TTL — so a correct identical answer to a new message still sends (ARCHITECTURE.md §V S3 as amended; `replyDedupScope`, pinned by `extensions/gateway/src/__tests__/dedup-reply-scope.test.ts`). Notices and agent-initiated sends are keyed on `(sessionId, sha256(content))`. Streaming-finalization races, retries, and adapter quirks cannot produce double-sends. This is the single dedup chokepoint — adapters do not roll their own.

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

## See also

- [Why is Ethos's security model built on shared responsibility?](../white-paper.md) — the main page this one continues.
