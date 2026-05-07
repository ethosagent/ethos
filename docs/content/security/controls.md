---
title: Security Controls
description: The catalogue of security controls that ship with Ethos — approval gates, scoped storage, channel allowlists, network reach, watcher, redaction, injection defenses, skill scanning, audit substrate.
sidebar_position: 3
---

# Security Controls

Most controls on this page are shipped — code in `packages/` and `extensions/`, tests next to it, audit trail in `observability.db`. A small number are **planned** with a designed interface but the enforcement not yet wired; those are tagged inline so customers can plan around them.

Where a control has a per-personality knob, the default is the safer option and the override is documented inline.

The controls fire in the order documented in the [Overview's runtime precedence diagram](./overview#the-runtime-precedence--what-fires-when). If two controls conflict, the earlier one wins.

**Reading the status tags:**

- *Shipped* — code lives at the linked path, tests cover it, audit events flow through `observability.db`. Customers can rely on enforcement today.
- *Partial* — core path implemented, some sub-cases (e.g. transport-level integration) still landing.
- *Planned* — interface and design are in place; enforcement not yet wired. Documented here so the eventual landing is not a surprise.

## 1. Channel-level controls (Telegram, Discord, Slack, email)

A channel adapter is the front door. If anyone who knows your bot's handle can DM it, every other layer has to clean up after the first compromise.

### Channel allowlist

Per-platform sender allowlists. A Telegram numeric user ID, a Discord snowflake, a Slack `U…` ID, or an email glob. Senders not on the list are dropped before the message reaches the agent loop.

- Source: `extensions/safety-channel/src/channel-filter.ts`
- Tests: `extensions/safety-channel/src/__tests__/channel-filter.test.ts`
- Audit category: `channel.allow` / `channel.deny`

### One-time DM pairing codes

To add a new sender, the operator issues a one-time pairing code. The code is sender-bound (only redeemable by the sender it was issued to), nonce-bound (cryptographic random; never reused), atomically consumed (the consume is the only allowed transition; replay fails), and rate-limited.

- Source: `extensions/safety-channel/src/pairing-store.ts`
- Tests: `extensions/safety-channel/src/__tests__/pairing-store.test.ts`
- Audit category: `channel.pairing`

### Mention-gate (groups only)

*Status: Shipped.*

In a multi-user channel (group chat, Slack workspace), the agent only responds when explicitly mentioned. Drive-by hijacking by pasting a wall of text into a public channel doesn't reach the LLM at all. The owner can bypass the gate (the `/allow` flow needs to work from any channel) — non-owners cannot.

- Source: `extensions/safety-channel/src/channel-filter.ts:125`

### Context-visibility filter

*Status: Shipped.*

Quoted text and forwarded content are treated as untrusted by default — they enter the LLM context with provenance markers (see §5 below) so the LLM and the runtime classifier both know "this is content the user did not author." The mode is per-channel: `all` (everything visible), `allowlist` (only allowlisted senders' content visible), `allowlist_quote` (allowlisted senders + their quoted context).

- Source: `extensions/safety-channel/src/channel-filter.ts:25,133`

## 2. Tool-level controls

### Per-personality toolset enforcement

The personality's `toolset.yaml` is a hard allowlist enforced at the framework layer, not advisory. `DefaultToolRegistry.toDefinitions(allowedTools)` filters the tool list the LLM sees, and `executeParallel` rejects calls outside the allowlist with a `tool_result` carrying `is_error: true` (preserving the Anthropic message contract).

- Source: `packages/core/src/tool-registry.ts:57`
- The `researcher` personality cannot suddenly run `bash` because a skill instructed it to; the tool isn't in its toolset, so it never reaches the model.

### Hardline blocklist (non-overridable)

A small set of operations is always-deny, regardless of personality, regardless of approval. The danger predicate fires before any approval check.

- Source: wired through `extensions/web-api/src/services/approval-hook.ts`
- Audit category: `audit.block`

### Risk classifier (mode-aware, per-call)

Every tool call is scored against a pattern-based classifier (regex floor) and an LLM-based classifier (Tier-2). The score determines whether the call goes through, requires approval, or is blocked. Sandbox attestation can relax the classifier for execution backends that declare strict confinement properties (read-only root, no host mounts, egress controls, no docker socket, non-root) — but only attested-strict backends earn the relaxation.

- Pattern source: `extensions/safety-injection/src/pattern-check.ts`
- LLM classifier: `extensions/safety-injection/src/classifier.ts`
- Sandbox attestation contract: `packages/types/src/sandbox.ts`

### Approval modal

When any of the previous checks flag a call, the request is held in front of the approval surface (Web UI modal or CLI prompt). The approval is binary, sender-attributable, and persisted as an audit event.

- Source: `extensions/web-api/src/services/approval-hook.ts`
- Audit category: `audit.approval`

## 3. Filesystem controls

### `ScopedStorage` and `BoundaryError`

All filesystem access under `~/.ethos/` flows through the `Storage` interface from `@ethosagent/types`. `ScopedStorage` is a decorator that enforces a per-personality read/write path allowlist with a global always-deny floor for sensitive paths (the `~/.ssh/` pattern, etc.). Out-of-scope reads throw `BoundaryError`, which the surface translates into a user-facing tool error.

- Source: `packages/storage-fs/src/scoped-storage.ts`
- Cross-personality isolation tests: `extensions/tools-file/src/__tests__/boundary.test.ts`
- The `engineer` personality cannot read the `researcher`'s `MEMORY.md`. Verified by test.

### Symlink-misdirection handling

*Status: Shipped (misdirection defense). TOCTOU-race closure: Planned.*

After path expansion, Ethos calls `realpath()` to resolve symlinks and re-checks the resolved path against the personality's `fs_reach`. This defends against the **symlink-misdirection bypass** — a symlink at `~/proj/notes.md → ~/.ssh/id_rsa` planted inside an allowed directory is rejected after resolution, not let through by naive prefix match.

What this does **not** close on its own is the resolve-then-open TOCTOU race: an attacker who can swap a path between the `realpath()` and the `open()` can still redirect the read. Closing that race requires kernel-tied operations (`openat`-style directory handles plus no-follow semantics) — designed for, tracked separately, not yet wired in. The source comments note this explicitly.

- Source: `extensions/tools-file/src/index.ts:30-44,169`

### Bash + filesystem boundary

*Status: Planned.*

The intended enforcement: if a personality's toolset includes `bash`, an attested-strict execution backend is **required at config-load time** — not a UI warning, not a runtime check. A personality that wants `bash` without sandbox attestation fails the configuration validation.

The `SandboxAttestation` interface and `isStrictAttestation()` helper ship today, so the gating logic has a stable contract to call. The config-load validator that wires them together is in flight; until it lands, an unsandboxed `bash` produces a runtime warning rather than a config-load failure.

- Interface: `packages/types/src/sandbox.ts`
- Helper: `isStrictAttestation()`

## 4. Network controls

### Per-personality network policy

A personality's `config.yaml` declares its network reach (hosts, ports, protocols). The default is conservative; the override is explicit.

- Source: `packages/types/src/personality.ts:46–52`

### SSRF protection

The `safe-fetch` wrapper rejects requests to private IP ranges, link-local addresses, loopback, and the cloud metadata endpoints (AWS `169.254.169.254`, GCP `metadata.google.internal`, Azure equivalents).

- Source: `extensions/safety-network/src/safe-fetch.ts`
- Cloud metadata blocklist: `extensions/safety-network/src/cloud-metadata.ts`

### Scheme allowlist

URLs must use `http` or `https`. `file://`, `gopher://`, `ftp://`, and `data:` are always rejected. The check fires on the original URL **and on every redirect hop** — a server-side `302` to `file:///etc/passwd` is rejected at the redirect, not at the request.

- Source: `extensions/safety-network/src/scheme.ts`

### DNS pinning per HTTP client

*Status: Partial.*

`safe-fetch` resolves the hostname via `node:dns/promises#lookup`, validates the resolved IP against the SSRF rules, and rejects the request before the connection is opened. This blocks the canonical "the URL is allowlisted; the IP it resolves to is private" case at request time.

The transport-level pinning that prevents a re-resolution between the SSRF check and the connect (undici `connect.lookup` override, native `http.request` agent override) is the next step. Designed for, not yet wired in. Documented in the source comments at the linked paths.

- Source: `extensions/safety-network/src/safe-fetch.ts:15-27`

## 5. Prompt-injection defenses

Tool results that re-enter the LLM context are the dominant vector for indirect prompt injection. Three independent layers handle this.

### Provenance wrapping

Every tool result is wrapped with provenance markers identifying the source (skill, web fetch, channel quote) before it enters the LLM context. The system prompt instructs the model to treat wrapped content as untrusted.

- Source: `extensions/safety-injection/src/wrap.ts`
- System prompt: `INJECTION_DEFENSE_PRELUDE` injected into every personality's prompt

### Two-tier classifier

Tier 1 is a regex-based pattern check covering the obvious phrases ("ignore previous instructions", "override system prompt", base64-encoded blobs, hidden Unicode). Tier 2 is an LLM-based classifier that runs over longer content with a sampling budget. Short suspicious payloads still get the structured short-pattern check — there's no fixed-threshold gate that lets sub-128-character injections through.

- Source: `extensions/safety-injection/src/classifier.ts`, `extensions/safety-injection/src/pattern-check.ts`

### Post-read tool downgrade

After a read from an untrusted source flags the classifier, a configurable subset of tools is locked out for the next two turns. The hijacked agent can't immediately turn around and call `web_post` to exfiltrate.

- Source: `extensions/safety-injection/src/downgrade.ts`
- Audit category: `audit.injection_flag`

## 6. Watcher (independent observer)

Ethos's agent loop is a typed `AsyncGenerator<AgentEvent>`. The watcher consumes the event stream out-of-band and applies rules that catch failure modes the in-loop checks can't see: rate-limit (too many tool calls per unit time), token-budget (cumulative tokens this turn), compounding-error (N consecutive failures), suspicious-sequence (read-untrusted → call-network within K turns).

The watcher returns `pause` / `terminate` / `allow` decisions. A pause holds the next tool call for human review; a terminate ends the turn.

- Source: `extensions/safety-watcher/src/watcher.ts`, `extensions/safety-watcher/src/rules.ts`
- Audit category: `audit.watcher`

## 7. Credential redaction

Credential redaction is **always on** at the observability store layer. Every value written to `observability.db` flows through `redactString` and `redactJson` first. Per-personality config controls whether tool args / tool bodies / LLM payloads are stored at all (`'none' | 'redacted' | 'full'`), but the redacted-mode pattern set is non-bypassable.

- Source: `extensions/observability-sqlite/src/redact.ts`
- Per-personality knobs: `packages/types/src/personality.ts:2–5` (`storeToolArgs`, `storeToolBodies`, `storeLlmPayloads`)
- Audit category: `audit.redacted`

The patterns cover Anthropic API keys, OpenAI API keys, generic bearer tokens, AWS access keys, and a small set of high-confidence secret formats. The redaction is applied **before** the value reaches disk — a `tool_error` containing `sk-ant-…` is replaced with `sk-ant-[REDACTED]` in the audit log, the LLM context (next turn's history), and any user-shared diagnostic bundle.

## 8. Skill and plugin install controls

### Static-analysis pattern scanner

Newly installed skills and plugins are scanned for prompt-injection patterns (hidden Unicode, base64 blobs, instructions to call sensitive tools), declared-but-unused permissions, and required-tool inflation (a "format-a-date" skill that declares `required_tools: [bash, web_post]`).

- Source: `extensions/safety-scanner/src/skill-scanner.ts`, `extensions/safety-scanner/src/plugin-scanner.ts`
- Audit category: `install.scan`

### Trust tiers

A skill is `community` (third-party) by default. Operators can promote skills to `partner` or `internal` tiers, which relax certain checks (e.g. an internal skill may declare `bash` without a scanner warning). Promotion is a deliberate operator action and is audit-logged.

- Source: `extensions/safety-scanner/src/trust-tiers.ts`

### MCP environment minimization

When Ethos spawns an MCP server subprocess, it strips `HOME`, sensitive env vars, and the inherited env tail before the child starts. The MCP server gets a sanitized temp `HOME` per server so credential files (`.npmrc`, `.aws/credentials`, etc.) cannot be read by inheriting the host environment.

- Source: `extensions/safety-scanner/src/mcp-env.ts`

## 9. Audit substrate — `observability.db`

Every safety decision lands in `observability.db` as a typed event. The schema is documented in `packages/types/src/observability.ts:53–63`.

| Category | What it records |
|---|---|
| `audit.transition` | Personality switch, model swap, session boundary |
| `audit.approval` | Operator approved or denied a tool call (with sender attribution) |
| `audit.block` | Hardline blocklist denied a tool call |
| `audit.watcher` | Watcher paused or terminated a turn |
| `audit.injection_flag` | Classifier flagged a tool result as suspicious |
| `audit.redacted` | Redaction count for a write — how many credential patterns were caught |
| `channel.pairing` | Pairing code issued / consumed / rejected |
| `channel.allow` / `channel.deny` | Sender allowlist match / miss |
| `install.scan` / `install.event` | Skill / plugin install scan result; install completed |

The store uses STRICT mode SQLite, WAL, and FTS5. Retention is configurable per category. Policy snapshots let you reconstruct "what was the personality's network policy at the time the agent fetched this URL" — useful when investigating an incident.

- Source: `extensions/observability-sqlite/src/store.ts`, `extensions/observability-sqlite/src/service.ts`

## What's per-personality vs. global

This table reflects the **policy split** for each control — which knobs are operator-tunable per personality vs. always-on globally. The status tag on each control above tells you whether the listed knob is enforced today; for *Planned* and *Partial* items the table describes the policy split for when the control fully ships.

| Control | Per-personality | Global (always on) |
|---|:---:|:---:|
| Channel allowlist + pairing | ✅ | ❌ |
| Toolset enforcement | ✅ | ❌ |
| Hardline blocklist | ❌ | ✅ |
| Risk classifier | ✅ (mode) | ✅ (engine) |
| `ScopedStorage` boundary | ✅ | ✅ (always-deny floor) |
| Network policy | ✅ | ✅ (SSRF, scheme, cloud-metadata) |
| Provenance wrapping | ❌ | ✅ |
| Post-read tool downgrade | ✅ (which tools) | ✅ (mechanism) |
| Watcher rules | ✅ (config) | ✅ (engine) |
| Credential redaction | ✅ (modes) | ✅ (pattern set) |
| Skill / plugin scanner | ❌ | ✅ |
| Audit substrate | ✅ (retention) | ✅ (write path) |

The pattern is consistent: the *engine* is global and non-bypassable; the *policy* is per-personality so different roles can take different risk postures. A `researcher` personality can be more permissive on network reach than an `engineer` personality without weakening the SSRF or cloud-metadata controls — those apply to both.

## Verifying these controls yourself

Every control above lists a source path. Read the code. Read the tests next to it. Run the test suite:

```bash
pnpm check
```

The tests include adversarial bypass attempts — encoding tricks, redirect chains, symlink races — not just happy-path verification. If a test fails on your branch, you've found a regression in a control we depend on.

## Next steps

- [Pre-Launch Hardening Pass](./security-fixes) — the sixteen issues a security review surfaced before this framework shipped, and how each was folded in.
- [Threat Model](./threat-model) — what each control is defending against, in plain language.
- [Responsible Disclosure](./responsible-disclosure) — how to report a control bypass.
