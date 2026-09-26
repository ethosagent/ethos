---
title: Security controls
description: Catalogue of shipped, partial, and planned security controls — channel, tool, filesystem, network, injection, watcher, redaction, install, audit.
kind: reference
audience: shared
slug: security-controls
updated: 2026-09-25
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

## Channel-level controls {#channel-level-controls}

A channel adapter is the front door. If anyone who knows your bot's handle can DM it, every other layer has to clean up after the first compromise.

Channel controls are operator settings, one block per platform under `channel_filter.<platform>.*` in `~/.ethos/config.yaml`. They are not personality fields. A platform with no `channel_filter` block admits every sender (`checkMessage` returns `allow` when the platform has no config).

### Channel allowlist {#channel-allowlist}

*Status: Shipped.*

Per-platform sender allowlists: the platform's `ownerUserId` plus `recipientAllowlist`. An entry is an exact sender id (a Telegram numeric user ID, a Discord snowflake, a Slack `U…` ID) or, for email, a leading-`*` suffix pattern such as `*@example.com` (`matchesGlob`, which handles only a leading wildcard).

A non-allowlisted sender in a group is dropped. A non-allowlisted sender in a DM follows `dmPolicy`: `pairing` (the default) answers with a pairing code instead of passing the message to the [agent loop](../getting-started/glossary.md#agent-loop); `allowlist`, `reject`, `silent-drop` and `queue` all drop it.

- Source: `checkMessage` in `packages/safety/channel/src/channel-filter.ts`
- Tests: `packages/safety/channel/src/__tests__/channel-filter.test.ts`
- Audit: a drop is recorded as `audit.block` by the gateway, code `channel.allowlist.blocked` for a DM and `channel.mention_gate` for any group drop (`extensions/gateway/src/index.ts`). An admitted message records nothing. `channel.allow` is recorded when an owner approves a pairing code (code `channel.pairing.approved`); `channel.deny` when an owner runs `/deny` (code `channel.allowlist.removed`).

### One-time DM pairing codes {#one-time-dm-pairing-codes}

*Status: Shipped.*

An unknown sender who DMs the bot on a platform with `dmPolicy: pairing` receives a one-time code (`generateCode`, called from `checkMessage`). The **owner** redeems it to approve that sender: `/allow <code>` in the gateway, or `/allow <code>` in the chat REPL (`runPairingCommand` in `apps/ethos/src/commands/pairing-commands.ts`). The sender does not redeem the code.

| Property | What the code does | Enforced by |
|---|---|---|
| Bound to one sender | The code row stores the `sender_id` and platform it was issued for; redemption approves exactly that sender | `consumeAndAllow` in `packages/safety/channel/src/pairing-store.ts` |
| Owner-only redemption (gateway) | `/allow` is refused unless the caller is the code platform's `ownerUserId` | `senderIsOwner` check in the gateway's `/allow` handler, `extensions/gateway/src/index.ts` |
| Random | 8 random bytes (`randomBytes(8)`), hashed to an 8-character code. Uniqueness rests on the table's primary key; a collision throws rather than retrying | `generateCode`, `makeCode` |
| Expires | One hour | `CODE_TTL_MS` |
| Single use | The `pending → consumed` flip and the allowlist insert run in one transaction; a replay finds `consumed` | `consumeAndAllow` |
| Issue rate limit | One pending code per sender per platform per 10 minutes; further DMs in that window are dropped | `generateCode` (`RATE_LIMIT_WINDOW_MS`) |
| Redeem rate limit | 5 failed redemptions per owner in 10 minutes, or 20 failed redemptions globally, pauses that owner for 24 hours | `recordFailedAttempt` (`LOCKOUT_THRESHOLD`, `GLOBAL_LOCKOUT_THRESHOLD`, `LOCKOUT_DURATION_MS`) |

The redeem rate limit applies only when an owner id is passed, which the gateway does. The chat REPL's `/allow` passes none, because the person at the REPL is the operator.

- Tests: `packages/safety/channel/src/__tests__/pairing-store.test.ts`
- Audit category: `channel.pairing`, recorded by the gateway (`Gateway.recordPairing` → `recordChannelPairing`, `extensions/gateway/src/index.ts`) with code `channel.pairing.issued` when a code is issued and `channel.pairing.redeem_failed` when an `/allow` fails. The outcome is one of `issued`, `not_owner`, `not_found`, `consumed`, `expired`, `sender_mismatch` or `owner_paused`; the code itself is never recorded. A rate-limited issue writes no `channel.pairing` event — it shows only as the `channel.allowlist.blocked` drop. A successful approval, including `/communications approve-all`, records `channel.allow` (code `channel.pairing.approved`). Pinned by `extensions/gateway/src/__tests__/pairing-audit.test.ts`.
- Limitation: the chat REPL's `/allow` (`runPairingCommand`) does not go through the gateway and writes no audit event — neither `channel.pairing` on failure nor `channel.allow` on success.

### Mention-gate (groups only) {#mention-gate}

*Status: Shipped.*

In a group, an allowlisted sender's message is dropped unless it mentions the bot. Drive-by hijacking by pasting a wall of text into a public channel doesn't reach the LLM at all. The owner bypasses the gate, so `/allow` works from any channel; non-owners cannot.

- Source: step 6 of `checkMessage` in `packages/safety/channel/src/channel-filter.ts`

### Context-visibility filter {#context-visibility-filter}

*Status: Shipped.*

Two separate mechanisms handle content the user did not author.

**Provenance marking.** The gateway wraps every admitted inbound message with `wrapUntrusted` before the agent loop sees it: the message text as `channel_message`, and any adapter-supplied channel history as `channel_history` (`extensions/gateway/src/index.ts`). This applies whatever `contextVisibility` says. Nothing handles forwarded content as a separate case.

**Visibility filter.** `channel_filter.<platform>.contextVisibility` removes content from non-allowlisted senders:

| Mode | Behaviour |
|---|---|
| `all` (default) | Nothing removed. |
| `allowlist` | When the message replies to a non-allowlisted sender (`replyToUserId` set and not on the allowlist), `>`-quoted lines are stripped. Channel history keeps only lines whose author is allowlisted; history the adapter did not attribute per line is dropped whole (`filterPriorContext`). If the adapter does not supply `replyToUserId`, quoted lines are kept. |
| `allowlist_quote` | Alias of `allowlist`. Same behaviour. |

- Source: step 7 of `checkMessage` in `packages/safety/channel/src/channel-filter.ts`

## Tool-level controls {#tool-level-controls}

### Per-personality toolset enforcement {#per-personality-toolset-enforcement}

*Status: Shipped.*

The personality's `toolset.yaml` is a hard allowlist for **built-in** tools, enforced at the framework layer. `DefaultToolRegistry.toDefinitions(allowedTools)` filters the [tool](../getting-started/glossary.md#tool) list the LLM sees, and `executeParallel` rejects calls outside the allowlist with a `tool_result` carrying `is_error: true` (preserving the Anthropic message contract).

Three kinds of tool are not gated by `toolset.yaml`:

| Tool kind | Gated by |
|---|---|
| MCP tools (`mcp__<server>__<tool>`) | The personality's MCP server allowlist and per-server tool allowlist (`passesFilter`) |
| Plugin tools | The personality's `plugins` allowlist (`passesFilter`) |
| Tools that set `alwaysInclude` | Nothing at the toolset layer; only the surface's `excludeTools` removes them |

- Source: `toDefinitions` and `passesFilter` in `packages/core/src/tool-registry.ts`
- Example: the built-in `researcher` personality's `toolset.yaml` has no `terminal` (the shell tool), so a [skill](../getting-started/glossary.md#skill) that tells it to run a command cannot: the tool never reaches the model.

### Hardline blocklist {#hardline-blocklist}

*Status: Shipped.*

A small set of operations is always-deny, regardless of personality, regardless of approval, on every surface except the web. The danger predicate fires before any approval check. On the CLI, TUI, ACP and gateway loops the terminal and process guard hooks refuse the call outright. The web profile asks instead of blocking: a hardline call always reaches the approval card, never a stored grant or lease, and approving it covers that one call only.

- Source: `packages/wiring/src/danger-predicate.ts` (`hardlineReason`), `packages/wiring/src/compose-tools.ts` (guard hooks, non-web), `apps/web-api/src/services/approvals.service.ts` (web: `requestApproval` and `approve`), pinned by `apps/web-api/src/__tests__/services/approvals-hardline.test.ts`
- Audit: a refused call is recorded as `audit.block` with code `tool_blocked` — the generic code every `before_tool_call` refusal records (`refuse` in `packages/core/src/agent-loop/stages/per-call-enforcement.ts`). No code distinguishes a hardline refusal from any other hook refusal; the event's `cause` carries the reason text.
- Shell-string shapes on the list include the inline-eval wrappers (`bash -c` and its siblings, `eval`, `python -c`, `node -e`, anything piped into a shell) and case-variant `rm`. The wrappers are read from each command's arguments, so an eval flag after other options (`bash -o pipefail -c`) or a wrapper in front of the shell (`| sudo -u root sh`) is still caught: `inlineEvalReason` and `PATTERNS` in `extensions/tools-terminal/src/guard.ts`, copied in `extensions/tools-process/src/guard.ts`. `perl -e`, `ruby -e` and `php -r` are not on the list; the file's header names what else gets past it.
- Command substitution (`$(…)` and backticks) is **not** on the list. It requires approval instead, so `kill $(lsof -t -i:3000)` can run once a human says yes. See [Approval modal](#approval-modal).

### Risk classifier (mode-aware, per-call) {#risk-classifier}

*Status: Shipped (rule-based, per call). Not shipped (sandbox attestation relaxation).*

Rules decide whether a tool call runs, asks for approval, or is refused. No score is involved. `createDangerPredicate` applies them per call, for the personality's approval mode: a hardline command is refused, a call in a flag set asks (see [Approval modal](#approval-modal)), and every other call runs.

The pattern check and the LLM classifier in `packages/safety/injection/` do not judge tool calls. They check the *results* of tools that declare `outputIsUntrusted` (`handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`). See [Two-tier classifier](#two-tier-classifier).

Sandbox attestation relaxes nothing today. Execution backends implement `attest()`, but nothing on a running turn's path reads the result. The only caller of `isStrictAttestation` is the backend conformance suite (`packages/core/src/execution/conformance.ts`), as `packages/types/src/sandbox.ts` records.

- Rules: `packages/wiring/src/danger-predicate.ts` (`createDangerPredicate`, `hardlineReason`, `approvalRequiredReason`)
- Sandbox attestation contract (no consumer on the turn path): `packages/types/src/sandbox.ts`

### Approval modal {#approval-modal}

*Status: Shipped.*

When any of the previous checks flag a call, the request waits for a human on three surfaces: the web UI modal (`apps/web-api/src/services/approval-hook.ts`), the Slack, Telegram and Discord approval cards (`createSlackApprovalHook` in `apps/ethos/src/approval-coordinator.ts`, registered by `wireApprovalFlow` in `apps/ethos/src/commands/gateway.ts`), and the operator's terminal in `ethos chat`. The approval is binary, sender-attributable, and persisted as an audit event.

`ethos chat` asks before a flagged call. The readline REPL prints the tool, the reason and a redacted, 300-character preview of the args, then reads `y/N`; anything but `y` or `yes` refuses. The TUI shows the same in a modal. The gate is `wireTerminalApprovalGate` with `createTerminalApprovalSource` (`apps/ethos/src/terminal-approval.ts`); the surfaces are `attachCliApprovalPrompt` (`apps/ethos/src/lib/cli-approval-prompt.ts`) and `ApprovalModal` (`apps/tui/src/components/ApprovalModal.tsx`). It flags the same calls as the web modal and the cards (`createApprovalDangerPredicate` in `packages/wiring/src/approval-seams.ts`), refuses a hardline call before asking, denies an unanswered prompt after `approvalTimeoutMs` (default 10 minutes, `ApprovalCoordinator.requestApproval`), and audits each decision. Pinned by `apps/ethos/src/__tests__/terminal-approval.test.ts` and `apps/tui/src/__tests__/approval-modal.test.ts`.

Where nobody can answer, a flagged call is refused rather than run:

| Run | Gate |
|---|---|
| `ethos chat -q`, `ethos chat` on piped stdin, `ethos acp` | `wireTerminalApprovalGate` with `coordinator: null` (`apps/ethos/src/terminal-approval.ts`) |
| `ethos -z`, `ethos batch`, `ethos eval`, `ethos personality judge` and the nightly scoring pass, `ethos bench`, the `ethos mcp serve` operator console | `gateNonInteractiveLoop` (`apps/ethos/src/lib/non-interactive-approval.ts`), pinned by `apps/ethos/src/__tests__/non-interactive-approval.test.ts` |
| `ethos cron run`, `ethos cron daemon` | `gateCronLoop` (same file), which reuses the gateway's `wireUnattendedApprovalGate`; pinned by `apps/ethos/src/__tests__/cron-approval-parity.test.ts` |

Limitation: `ethos acp` does not forward an approval to its client through `session/request_permission`, so an ACP client cannot approve a flagged call; it is refused.

No surface asks about a call that will be refused anyway. A tool outside the personality's toolset is refused without a card, prompt or modal (`notPermittedRefusal` in `packages/wiring/src/approval-seams.ts`, passed as `refusedAnyway` to `createSlackApprovalHook` and to `createWebApprovalHook`).

- Source: `apps/web-api/src/services/approval-hook.ts`, `apps/ethos/src/approval-coordinator.ts`, `apps/ethos/src/terminal-approval.ts`
- Audit category: `audit.approval`
- Per-personality knob: `safety.approvalMode` — `manual` | `smart` | `off` (`packages/types/src/personality.ts`). Default is `manual`. `off` auto-approves a flagged call through the `allowAutoApproveDangerousTools` capability of `createDangerPredicate`, which two callers pass. `wireTerminalApprovalGate` always passes it, so `off` runs flagged calls unasked in `ethos chat`, `ethos acp` and the non-interactive commands above. `wireUnattendedApprovalGate` passes it only when the operator sets `allowUnattendedDangerousTools: true`; that covers the gateway's cron/dream loop and `ethos cron`. Everywhere else `off` behaves as `manual`. A hardline call is refused in every mode.
- What is flagged: `createDangerPredicate` in `packages/wiring/src/danger-predicate.ts`. Every mode flags `APPROVAL_SURFACE_ALWAYS_ASK`; `smart` adds `SMART_MODE_CONSEQUENTIAL_TOOLS`; and when the personality runs on a host-local, non-containerized execution posture, every mode adds `LOCAL_POSTURE_CONSEQUENTIAL_TOOLS` (`terminal`, `process_start`, `run_tests`, `lint`).
- Command substitution: a `terminal`, `run_tests`, `lint` or `process_start` command containing `$(…)` or backticks is flagged in every mode, on any execution posture (`approvalRequiredReason` in `packages/wiring/src/danger-predicate.ts`). The web modal, the chat approval cards and the `ethos chat` prompt ask; the terminal and process guards leave it to the gate because the gate marks itself with `markHostApprovalGate`. The `off` capability never auto-approves it (`createDangerPredicate` in the same file), so under `approvalMode: off` `ethos chat` still asks, and the unattended gate refuses it even with `allowUnattendedDangerousTools: true`. A surface with nobody to ask refuses it: the unattended gate, a chat surface with no cards, the MCP export, and the runs in the table above. Pinned by `packages/wiring/src/__tests__/command-substitution-guard.test.ts` and `apps/ethos/src/commands/__tests__/command-substitution-approval.test.ts`.

## Filesystem controls {#filesystem-controls}

### ScopedStorage and BoundaryError {#scoped-storage-and-boundary-error}

*Status: Shipped (file-tool and storage boundaries). Not covered (a global guarantee that every `~/.ethos/` access is scoped).*

A personality's filesystem reach is its `fs_reach` allowlist plus a global always-deny floor for sensitive paths (`.ssh`, `.aws/credentials`, `/etc/passwd`, and similar). Two decorators enforce it:

| Decorator | Guards | Refusal |
|---|---|---|
| `ScopedFsImpl` (`packages/core/src/scoped/scoped-fs.ts`), built from `fs_reach` in `packages/core/src/capability-resolver.ts` | The file tools' `ctx.scopedFs` | `Error` whose message starts `PATH_NOT_REACHABLE:`; the file tool turns it into a tool error |
| `ScopedStorage` (`packages/storage-fs/src/scoped-storage.ts`) | A `Storage` handed to a personality-scoped consumer | `BoundaryError`, which the surface turns into a tool error |

Not every read or write under `~/.ethos/` goes through either decorator. The SQLite stores, locks, the backup engine and the other modules on the raw-`node:fs` carve-out list in `CLAUDE.md` open paths directly; they are framework code, not tool reach.

- Cross-personality isolation tests: `extensions/tools-file/src/__tests__/boundary.test.ts` (for example, `researcher CANNOT read engineer's MEMORY.md`)
- Audit: a reach refusal is returned to the model as a tool error. No audit event is written for it.

### Symlink-misdirection handling {#symlink-misdirection-handling}

*Status: Shipped (misdirection defense). Not covered (check-then-open race).*

The reach check does two things. First it normalises the path lexically — `normalize(resolve(path))` — so `..`, `.`, and redundant-slash traversal cannot walk out of an allowed prefix. Then, for a path already inside the reach, it walks **every segment** below the matched prefix with `lstat`. When it finds a symbolic link, it **follows** it and re-judges the deny floor and the allowlist against where the link lands, up to `MAX_SYMLINK_HOPS` (32) links.

| Link | Outcome |
|---|---|
| Lands outside the allowlist, e.g. `<allowed>/notes.md → ~/.ssh/id_rsa` | Refused at the link, before anything opens the target |
| Lands on the always-deny floor | Refused |
| Lands inside the allowlist | Allowed (`ALLOWS a symlink whose target is inside the allowlist` in `boundary.test.ts`) |
| Chain longer than 32 links | Refused |

The walk is per-segment rather than leaf-only because **a symlinked parent escapes with a non-symlink leaf**: `<allowed>/data → /etc` makes `<allowed>/data/passwd` an ordinary file whose link path passes any prefix test.

Normalisation alone does not close this. `resolve()` is a string operation and a symlink is a filesystem fact — the lexically-resolved link path is neither under a denied prefix nor outside the allowed one, so it passes the always-deny floor and the allow check both. The segment walk is what re-judges where the read actually lands.

The same walk exists as four hand-maintained copies, because the layer model stops them sharing code. All four follow a link, refuse an escape, and fail closed when a segment cannot be `lstat`ed for any reason other than not existing:

| Copy | Guards |
|---|---|
| `ScopedFsImpl.checkReach` (`packages/core/src/scoped/scoped-fs.ts`) | File tools |
| `ScopedStorage.check` (`packages/storage-fs/src/scoped-storage.ts`) | Scoped `Storage` |
| `containedPath` / `followFirstSymlink` (`packages/wiring/src/backup/restore.ts`) | Backup restore destinations |
| `DocumentsService.reachable` (`apps/web-api/src/services/documents.service.ts`) | The web Documents root |

A fix to one copy that is not applied to the others leaves the escape open on whichever path the caller takes. The comment above `followFirstSymlink` in `scoped-fs.ts` records the rule that all four change together.

What this does **not** close is the check-then-open race: an attacker who can swap a path between the walk and the `open()` can still redirect the read. Closing it needs `openat`-style directory handles with no-follow semantics, which Node does not expose. No code addresses it; treat it as container-level remediation.

- Tests: `extensions/tools-file/src/__tests__/boundary.test.ts`; `apps/web-api/src/__tests__/services/documents.service.fail-closed.test.ts` (the Documents copy refuses on any `lstat` error other than `ENOENT`)
- History: this defense was originally implemented as a path-canonicalisation call inside the file tools and was dropped during a refactor that centralised normalisation at the boundary, without this page being updated. See [Pre-launch hardening pass, entry 8](./security-fixes.md#8-symlink-misdirection) for the dated correction.

### Bash + filesystem boundary {#bash-filesystem-boundary}

*Status: Shipped (execution-posture gating). Not shipped (a config-load gate on sandbox attestation).*

There is no tool named `bash`; the shell tool is `terminal`. What stops a personality with shell access from running unconfined on the host is the resolved execution posture, not an attestation check.

| Situation | Outcome | Enforced by |
|---|---|---|
| Personality holds an exec tool, host is not containerized | Posture is `docker` | `resolveExecutionPosture` in `packages/wiring/src/resolve-execution-posture.ts` |
| Docker cannot be built in this process | Refused, unless the operator sets `execution.allowLocalFallback: true`; then an honestly labelled `local` posture | `resolveExecutionPosture` (`fallbackToLocal`) |
| The operator constitution sets `execution.requireSandbox` or `execution.forbidLocal` | The `local` posture is refused | `constitutionForbidsLocal` |
| Personality runs on a host-local posture | `terminal`, `process_start`, `run_tests` and `lint` need approval in every mode | `LOCAL_POSTURE_CONSEQUENTIAL_TOOLS` in `packages/wiring/src/danger-predicate.ts` |

Not shipped: `SandboxAttestation` and `isStrictAttestation()` exist in `packages/types/src/sandbox.ts`, but no config-load validator reads them and no runtime warning names an unsandboxed shell. The only caller of `isStrictAttestation` is the backend conformance suite.

- Posture tests: `packages/wiring/src/__tests__/resolve-execution-posture.test.ts`
- See also: [G-EXEC](./security-boundary.md#g-exec) in the security boundary

## Network controls {#network-controls}

### Per-personality network policy {#per-personality-network-policy}

*Status: Shipped.*

A personality's `safety.network` block narrows which hosts its tools may reach. It lists hosts only — no ports, no protocols. The scheme is a separate global gate (see [Scheme allowlist](#scheme-allowlist)).

```yaml
safety:
  network:
    allow:
      - api.github.com
      - "*.slack.com"
    deny:
      - uploads.example.com
    allow_private_urls: false
```

| Field | Meaning |
|---|---|
| `allow` | Host patterns: an exact host, a leading `*.` that matches the domain and its subdomains, or a bare `*` that matches every host (`hostnameMatches` in `packages/safety/network/src/policy.ts`). Absent, `[]` and `['*']` all mean no allow list. |
| `deny` | Same pattern grammar. Checked before `allow`, so deny wins (`checkAllowDeny`). A bare `*` denies every host. |
| `allow_private_urls` | Opts into RFC1918, loopback and link-local destinations. Default `false`. Cloud-metadata hosts stay blocked regardless. |

The set of hosts a tool can reach is the intersection of what the tool declares (`capabilities.network.allowedHosts`) and the personality's `allow` (`resolveCapabilities` in `packages/core/src/capability-resolver.ts`; refusals are `HOST_NOT_ALLOWED` from `ScopedFetchImpl`):

| Tool declares | No `safety.network.allow` | With `safety.network.allow` |
|---|---|---|
| Specific hosts (e.g. a search API) | The tool's declared hosts | Declared hosts that a personality pattern covers |
| `['*']` (e.g. `web_extract`) | Any public host | The personality's `allow` list |

With no allow list, a `['*']` tool reaches any public host, but only over `http(s)`: private, loopback, link-local and cloud-metadata destinations stay refused by `safeFetch` (`validateUrl` in `packages/safety/network/src/safe-fetch.ts`; see [SSRF protection](#ssrf-protection)). Declare an `allow` list on any personality whose web tools should reach only named hosts.

- Source: `PersonalitySafetyConfig.network` in `packages/types/src/personality.ts`; parsed in `extensions/personalities/src/index.ts`
- Tests: `packages/wiring/src/__tests__/personality-network-policy.test.ts`; `packages/core/src/__tests__/capability-resolver.test.ts` (`'*' tool on a personality with no allow list — real safeFetch`); `packages/safety/network/src/__tests__/policy.test.ts` and `safe-fetch.test.ts`

### SSRF protection {#ssrf-protection}

*Status: Shipped.*

`safeFetch` rejects requests whose resolved addresses are private (RFC1918), loopback, or link-local, unless the personality sets `allow_private_urls: true`. Operator-initiated A2A peering (`ethos a2a peer add` and the web Add-peer dialog) reads no personality's policy: its card fetch opts into private destinations only when `~/.ethos/config.yaml` sets `a2a.peering.allowPrivateUrls: true` (`A2aPeeringService.fetchVerified` in `packages/wiring/src/a2a-peering-service.ts`; pinned by `packages/wiring/src/__tests__/a2a-peering-private-urls.test.ts`). Cloud-metadata hosts are rejected even then: `169.254.169.254`, `metadata.google.internal`, `metadata`, `metadata.azure.com`, `metadata.aws.amazon.com`, `fd00:ec2::254`, Alibaba's `100.100.100.200`, and Oracle's `169.254.0.23`.

- Source: `validateUrl` and `safeFetch` in `packages/safety/network/src/safe-fetch.ts`
- Cloud metadata blocklist: `isCloudMetadataHost` in `packages/safety/network/src/cloud-metadata.ts`

### Scheme allowlist {#scheme-allowlist}

*Status: Shipped.*

URLs must use `http` or `https`. `file://`, `gopher://`, `ftp://`, `data:` and every other scheme are rejected, and so is a URL with embedded credentials (`http://user:pass@host`). `safeFetch` follows redirects manually, at most 5 hops, and re-runs the full check on every hop — a server-side `302` to `file:///etc/passwd` is rejected at the redirect, not at the request.

- Source: `checkScheme` in `packages/safety/network/src/scheme.ts`; the per-hop loop in `safeFetch` (`DEFAULT_MAX_REDIRECTS`)

### DNS pinning per HTTP client {#dns-pinning-per-http-client}

*Status: Shipped for `safeFetch`'s default transport. Not covered: an injected `fetchImpl`, and the browser route guard.*

`safeFetch` resolves the hostname once, validates every returned address, and then connects with `pinnedFetch`: undici's `fetch` with a per-request `Agent` whose `connect.lookup` (`pinnedLookup`) answers only with the addresses validation accepted. The socket connects to an address that was checked, so there is no second resolution for a DNS-rebinding attacker to win. Each redirect hop is re-validated and gets its own pinned `Agent`. The hostname still drives the Host header, TLS SNI and certificate verification.

Tools reach the network through `ctx.scopedFetch` — `ScopedFetchImpl`, which calls the real `safeFetch` on its default transport (the capability backends in `packages/wiring/src/build-infrastructure.ts`) — so `web_extract` and every other tool using `ctx.scopedFetch` is pinned. `web_extract`'s own `checkSsrf` lookup (`extensions/tools-web/src/ssrf.ts`) runs first as an early refusal only; the connection still goes through `safeFetch`.

| Path | Pinned? |
|---|---|
| `safeFetch` default transport, and every `ctx.scopedFetch` caller | Yes |
| A caller that injects its own `fetchImpl` — the one production case is the vision input resolver's `ctx.fetchImpl` seam (`extensions/tools-vision/src/input-resolver.ts`) | No: the injected function resolves however it likes |
| Browser sessions (`installRouteGuard`) | No: the guard validates the URL, and Chromium resolves the name again when it connects |

- Source: `pinnedFetch` and `pinnedLookup` in `packages/safety/network/src/safe-fetch.ts`
- Tests: `packages/safety/network/src/__tests__/safe-fetch.test.ts` ("connection pinning"); `extensions/tools-web/src/__tests__/web-extract-pinning.test.ts` (`web_extract` connects through the pinned transport)

### The browser SSRF guard does not survive an upstream proxy {#ssrf-browser-proxy}

*Status: Not covered. Read this before setting [`browser.proxy.server`](../using/reference/config-yaml.md#browser).*

Browser sessions carry their own SSRF guard: `installRouteGuard` puts a `context.route('**/*')` handler on every Playwright context, and each request is checked by the same `validateUrl` the fetch path uses, with hostnames resolved through `node:dns/promises#lookup`.

That resolution happens in the **Ethos process**. A proxied navigation is never resolved there. Chromium sends `CONNECT <host>:<port>` to the proxy and the **proxy** resolves the name, on its own resolver, inside its own network. So the guard checks an address the connection does not use, and a hostname that answers with a public IP here can answer with `10.0.0.5` inside the proxy's LAN. Ethos cannot see that and does not block it.

Literal IPs are unaffected — a URL with a private address in it is rejected before any resolution happens, proxy or not. The gap is names only, and it is not a bug we can close from this side: the resolver that matters belongs to the proxy.

Deploy a proxy you trust not to act as an SSRF pivot — one that cannot reach your internal network, or that enforces its own egress policy. The browser route guard is not that control and must not be relied on as one.

- Source: [`extensions/tools-browser/src/session-route.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/session-route.ts)

### A takeover hands a human the agent's live browser {#browser-takeover-exposure}

*Status: Shipped, opt-in per personality.*

`browser_request_takeover` pauses the agent and hands the **live browser session** to whoever answers the request. That session is not a blank window: it holds every cookie and every logged-in tab the agent accumulated, and when [`browser.profiles.enabled`](../using/reference/config-yaml.md#browser) is on it is signed into whatever that personality's persistent profile is signed into — across turns, and across `/new`.

Two things follow. The window itself is open on the machine running Ethos, so anyone at that machine can drive it. And the request is raised with `answerableBy: 'anyone'`, so in a group chat any member — not only the person the agent was talking to — may cancel it or follow the link into the web chat to hand it back.

Grant the tool in `toolset.yaml` only to personalities whose browser you are willing to hand over, and keep a persistent profile signed into accounts you would put in front of that audience.

- Source: [`extensions/tools-browser/src/browser-takeover.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/browser-takeover.ts)

## Prompt-injection defenses {#prompt-injection-defenses}

Tool results that re-enter the LLM context are the dominant vector for indirect prompt injection. Three layers handle this, and all three act on the results of tools that declare `outputIsUntrusted`.

### Provenance wrapping {#provenance-wrapping}

*Status: Shipped.*

Every result from a tool that declares `outputIsUntrusted` — success or error — is wrapped with provenance markers before it enters the LLM context (`handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`, called from `packages/core/src/agent-loop/stages/tool-processing.ts`). The marker names the tool and, where the arguments carry one, the source path, URL, command or query (`describeSource`). A result from a tool that does not declare `outputIsUntrusted` is not wrapped.

Two related mechanisms sit beside it:

| Mechanism | What it covers | Enforced by |
|---|---|---|
| Result delimiter fence | Every successful result, and every error that went through the untrusted path, is fenced in `===TOOL_RESULT_START:<name>===` … `===TOOL_RESULT_END===`, with forged delimiters in the content escaped. On by default; `safety.injectionDefense.toolResultDelimiters: false` turns it off | `tool-processing.ts` |
| Inbound channel messages | The gateway wraps each admitted message and its channel history (see [Context-visibility filter](#context-visibility-filter)) | `wrapUntrusted` calls in `extensions/gateway/src/index.ts` |

Skill and context files are not wrapped. Their lines are sanitized instead (see [Memory injection scanning](#memory-injection-scanning)).

- Source: `wrapUntrusted` in `packages/safety/injection/src/wrap.ts`
- System prompt: `INJECTION_DEFENSE_PRELUDE`, pushed into every personality's prompt by `packages/core/src/agent-loop/stages/context-assembly.ts` (a compact variant when `promptBudget.compactPrelude` is set)

### Two-tier classifier {#two-tier-classifier}

*Status: Shipped.*

Tier 1 runs on every untrusted result. It is regex-based:

| Check | Rules |
|---|---|
| `shortPatternCheck` (`packages/safety/injection/src/pattern-check.ts`) | `ignore-instructions`, `disregard`, `forget-instructions`, `role-override`, `new-instructions`, `inline-system`, `inline-assistant`, `template-token`, `bidi-override`, `zero-width` |
| `c2PatternCheck` (same file) | Exfiltration phrasing (`c2-exfiltrate-*`), `c2-system-override`, memory-persistence phrasing (`c2-memory-write`, `c2-remember-always`, `c2-persist-instruct`), secret-read phrasing (`c2-read-secrets`, `c2-exfil-keys`), and others |
| Template-token strip | Chat-template tokens are stripped by `wrapUntrusted`; a strip counts as a Tier-1 hit |

Tier 1 has no base64-blob detector; only the phrase rule `c2-exfiltrate-encode` touches encoding.

Tier 2 is an LLM classifier (`createLLMClassifier` in `packages/safety/injection/src/classifier.ts`, wired in `packages/wiring/src/build-agent-loop.ts`). It runs when Tier 1 hit, when the content is longer than 500 characters, or when `safety.injectionDefense.classifier.alwaysCallLLM` is `true` (`shouldCallLLM` in `result-defense.ts`). There is no sampling budget. Limitation: a payload of 500 characters or fewer that Tier 1 misses is not sent to Tier 2 unless `alwaysCallLLM` is set.

A Tier-2 failure is fail-open: the turn continues on the Tier-1 verdict and records `audit.block` with code `injection_classifier_failed`. A flagged result records `audit.block` with code `injection_detected` and shows the user a warning.

- Sources: `packages/safety/injection/src/classifier.ts`, `packages/safety/injection/src/pattern-check.ts`, `packages/core/src/agent-loop/result-defense.ts`

### Post-read tool downgrade {#post-read-tool-downgrade}

*Status: Shipped.*

Any result from an `outputIsUntrusted` tool — flagged or not, success or error — arms the downgrade (`untrustedReadThisIteration` in `tool-processing.ts`). While it is armed, calls to the downgraded tools are refused with `DOWNGRADE_REJECTION_MESSAGE`. It stays armed for the next `turns` loop **iterations** (default 2) within the same run, and clears when the user sends a new message, because each run starts the counter at zero.

The default tool list is `DEFAULT_DOWNGRADED_TOOLS` in `packages/safety/injection/src/downgrade.ts`: `terminal`, `run_code`, `run_tests`, `write_file`, `patch_file`, `web_extract`, `browse_url`, `browser_click`, `browser_type`, `process_start`, `process_stop`. A hijacked agent that has just read a poisoned page cannot immediately open a shell or type into a form.

- Source: `packages/safety/injection/src/downgrade.ts`; the gate in `packages/core/src/agent-loop/stages/tool-processing.ts`
- Audit: a refused call records `audit.block` with code `tool_downgraded_post_untrusted_read`
- Per-personality knob: `safety.injectionDefense.postReadDowngrade` — `{ enabled, turns, tools }`. `enabled` defaults to `true`, and `enabled: false` turns the downgrade off for that personality. `tools` replaces the default list.
- Other opt-outs in the same block: `toolResultDelimiters: false` removes the delimiter fence, and `blockSecretResults: false` stops secret redaction of tool results (see [Credential redaction](#credential-redaction)). Wrapping, the prelude and Tier 1 have no knob.

### Memory injection scanning {#memory-injection-scanning}

*Status: Shipped.*

Memory content — `MEMORY.md`, `USER.md`, and team topic files — is sanitized with `sanitize` (`packages/safety/injection/src/prompt-sanitize.ts`). Any line matching an injection pattern such as "ignore previous instructions", `[SYSTEM]`, or a role-override phrase is replaced with `[line removed by injection guard]`.

Memory is a higher-risk surface than context files. A single poisoned line in `MEMORY.md` re-injects into the system prompt on every subsequent turn and every future session. A poisoned `USER.md` crosses [personality](../getting-started/glossary.md#personality) boundaries, so every personality the user talks to sees it.

| Point | Personality memory | Team memory |
|---|---|---|
| Write | `memory_write` sanitizes before `sync()` (`extensions/tools-memory/src/index.ts`) | `team_memory_write` sanitizes before `sync()` |
| Tool read | `memory_read` sanitizes what it returns | `team_memory_read` sanitizes what it returns |
| Prompt assembly | The memory snapshot is sanitized before the system prompt is built (`packages/core/src/agent-loop/stages/context-assembly.ts`) | Only topic names are injected, not content |

The read-time pass catches content written before scanning existed or edited by hand on disk.

- Audit: none. A removed line is not recorded as an event.

## Watcher {#watcher}

*Status: Shipped (fixed default rule set).*

The watcher is a separate observer in the same process. `createWatcherTap` (`packages/core/src/agent-loop/watcher-tap.ts`) feeds it every tool event synchronously, and the loop consults its decision at iteration boundaries and before each call (`consultWatcherHalt`). Its rules do not depend on any other check classifying a call correctly.

| Rule | Fires when | Decision |
|---|---|---|
| `rate-limit` | More than 60 `tool_end` events in 60 seconds, counted across turns | `pause` |
| `token-budget` | More than 50,000 **output** tokens in one turn | `pause` |
| `compounding-error` | 5 consecutive failures of the same tool | `pause` |
| `suspicious-sequence` | A `read_file`, `search_files` or `terminal` call on a credential-shaped path (`.ssh`, `.aws/credentials`, `.gnupg`, `.netrc`, `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `authorized_keys`), followed within the last 4 calls by an exfiltration-shaped tool: one in `EXFIL_TOOL_NAMES` (`web_extract`, `browse_url`, `browser_navigate`, `browser_computed_style`, `video_analyze`, `meet_join`, `browser_type`, `browser_vision_type`, `send_message`, `call`, `a2a_send`, `route_to_agent`, `broadcast_to_agents`, `dispatch_team`) or any `mcp__*` tool (`isExfilShapedTool`) | `terminate` |

A `pause` emits a `halt` event, rejects the pending calls, and ends the turn with one closing model call that has no tools (`replyAfterWatcherPause`). No human review queue holds the call. A `terminate` ends the turn with an `error` event whose code is `watcher_<rule>`.

The list is drawn by destination: it names tools that can carry agent-chosen content to a destination the agent chooses, so a tool that only talks to a fixed provider (`web_search`) is not on it, and `terminal` counts only as a credential read. The list is pinned against the registered tools by `packages/wiring/src/__tests__/watcher-exfil-tool-names.test.ts`: every name must be a real tool, and every tool that declares `allowedHosts: ['*']` must be listed or exempted there with a reason.

- Source: `packages/safety/watcher/src/watcher.ts`, `packages/safety/watcher/src/rules.ts` (`defaultRules`)
- Audit category: `audit.watcher`
- Configuration: none per personality. Wiring always constructs the watcher with `defaultRules()` (`packages/wiring/src/build-agent-loop.ts`). The only bypass is the run option `allowDangerousToolCalls`.

## Credential redaction {#credential-redaction}

*Status: Shipped.*

Redaction runs in two places.

**Before disk.** The observability store redacts every trace attribute, span attribute, event detail and event cause it writes (`packages/safety/redact/src/index.ts` `redactString` / `redactJson`, applied in `extensions/observability-sqlite/src/store.ts`). The built-in pattern set covers Anthropic, OpenAI, Groq and xAI API keys, GitHub tokens, AWS access keys, Google API keys, Telegram, Slack and Stripe tokens, private keys, JWTs, bearer tokens, and a generic-secret shape. A match is replaced with a labelled tag such as `[REDACTED:anthropic-key]`.

**Before the model.** Every tool result's value, error and structured leaves are scanned (`redactToolResultSecrets` in `packages/core/src/agent-loop/stages/result-redaction.ts`) before any consumer sees the result, including the next turn's context. A detection records a `secret_in_tool_result` safety event, and the detected text is replaced unless the personality sets `safety.injectionDefense.blockSecretResults: false`.

| Knob (`safety.observability`) | Values | What it does |
|---|---|---|
| `storeToolArgs` | `none` \| `redacted` (default) \| `full` | `none` drops tool-call args from spans. `full` skips the personality's `redactPatterns`; the built-in patterns still apply. |
| `storeLlmPayloads` | `none` \| `metadata` \| `full` | `full` stores message content on the LLM span; it is redacted like every other attribute. |
| `redactPatterns` | regex strings | Extra patterns, replaced with `[REDACTED:custom]`. |
| `storeToolBodies` | `none` \| `redacted` \| `full` | Reserved. Accepted and shown on the character sheet, but tool result bodies are never stored in `observability.db` at any setting; only the result size is recorded (pinned by `packages/core/src/__tests__/tool-body-not-stored.test.ts`). |

`ethos support bundle` reads events that were already redacted in the store and strips secret-shaped fields from the config it includes (`stripSecrets` in `apps/ethos/src/commands/support.ts`). `--anonymize` only replaces the home directory, working directory, hostname and username.

- Source: `packages/safety/redact/src/index.ts` (`extensions/observability-sqlite/src/redact.ts` re-exports it)
- Audit: `audit.redacted` is **not** emitted today. `recordRedacted` exists in `packages/wiring/src/observability/ethos-observability.ts` and nothing calls it.

## Skill and plugin install controls {#skill-and-plugin-install-controls}

### Static-analysis pattern scanner {#static-analysis-pattern-scanner}

*Status: Shipped.*

Skills and plugins are scanned at install and promotion time.

| Scanner | Rules |
|---|---|
| `packages/safety/scanner/src/skill-scanner.ts` | `prompt-injection`, `hidden-unicode`, `base64-blob`, `sensitive-tool-instruction`, `role-override`, `external-url-instruction` |
| `packages/safety/scanner/src/plugin-scanner.ts` | `dynamic-code-exec`, `credential-access`, `fs-write-outside-safe-path`, `exfil-shape`, and `shell-exec` / `network-access` for capabilities the plugin **uses but did not declare** in `ethos.permissions` (`checkShellExec`, `checkNetworkAccess`) |

The scanner has no rule for declared-but-unused permissions and none for required-tool inflation.

The scanner is **pre-install and advisory**. It reads text before the code is installed; it sandboxes nothing, constrains nothing at runtime, and is evaded by string concatenation. It is published as a non-boundary — see [What is not a boundary](./security-boundary.md#non-boundaries) — and nothing on this page should be read as strengthening that.

- Audit category `install.scan`: one event per scan decision, with code `install.scan.pass`, `install.scan.warn`, `install.scan.needs_ack` or `install.scan.blocked`, built by `installScanEvent` (`packages/wiring/src/observability/install-scan.ts`). Details carry the kind, source, tier, verdict, finding counts and rule ids — never excerpts, file bodies or URL credentials. Emitted by `ethos skills install` (`scanSkillDir` in `apps/ethos/src/commands/skills.ts` → `recordInstallScan` in `apps/ethos/src/wiring.ts`), `ethos plugin install` (`installPlugin` in `apps/ethos/src/commands/plugin.ts` → `recordInstallScan`), and learning promotion (`learningPromoteDeps` in `packages/wiring/src/learning-pipeline.ts` → `recordSkillScan`). Pinned by `packages/wiring/src/__tests__/install-scan.test.ts`, `packages/wiring/src/__tests__/learning-pipeline.test.ts` and `apps/ethos/src/__tests__/install-scan-audit.test.ts`.
- Limitation: three scan paths write no `install.scan` event — plugin install from the web API, the plugin loader's load-time rescans, and `UniversalScanner` discovery.
- Audit category `install.event`: agent-mesh journal entries and `ethos data reset`.

### Trust tiers {#trust-tiers}

*Status: Shipped.*

There are four tiers. A tier is **derived from the source string** the skill or plugin was installed from, on every scan. It is not assigned per skill, cannot be promoted, and produces no audit event — there is no promotion action to record.

| Tier | Derived from | Yellow findings | Red findings |
|---|---|---|---|
| `builtin` | The literal source `builtin` — code shipped inside this repository | Auto-acknowledged | Installs with `--force` |
| `trusted-repo` | `github.com/<org>/<repo>` where `<org>` is listed in `security.trusted_github_orgs` | Acknowledgment required; `--force` stands in for it | Installs with `--force` |
| `community` | Any other `github.com/…`, `clawhub/…`, or `hermeshub/…` source | Acknowledgment required; `--force` stands in for it | Blocked; `--force` is ignored |
| `untrusted` | A local path or a raw URL | Acknowledgment required; `--force` stands in for it | Blocked; `--force` is ignored |

`builtin` is the only tier that auto-acknowledges yellow findings. Overriding a red finding with `--force` is the only privilege `trusted-repo` holds over `community`.

`security.trusted_github_orgs` is operator-configurable and **replaces** the shipped default (`ethosagent, anthropic`) rather than extending it. Set it to a different list to trust different organizations, or to an empty value to trust no organization by name. Organization matching is exact on the path segment. A `github.com/` source with a `.` or `..` segment yields no organization (`extractGitHubOrg`), so it is never `trusted-repo`; it is derived as `community`, not refused. See [`security.trusted_github_orgs`](../using/reference/config-yaml.md#security-trusted-github-orgs).

Residual risk: a red finding in a configured organization is overridable with `--force`.

- Source: `deriveTier` in `packages/safety/scanner/src/trust-tiers.ts`

### Plugin capability grants {#plugin-capability-grants}

*Status: Shipped.*

A grant is a **consent record, not runtime enforcement**. It is not a boundary and it does not confine a plugin.

`PluginLoader` `import()`s a plugin's entry module directly into the Ethos process. The plugin shares the process, the environment, the filesystem, and your API keys. Installing a plugin is equivalent to running arbitrary code as your user. This is an accepted, documented Tier 1 property — see [Gaps, disclosed](./security-boundary.md#gaps).

At install the operator is shown what the plugin **declares** in `ethos.permissions` (`shell` — intent to shell out; `network` — declared hosts, or none), told in plain words what installing it means, and their agreement is recorded durably alongside the scan findings as they stood at that moment. The record's field is named `capabilities`, and there are no per-capability toggles: it records what was declared and what was agreed to. Nothing checks a plugin against its declaration while it runs, and an undeclared capability is not blocked.

| Command | What it does |
|---|---|
| `ethos plugin grants` | Lists every recorded grant — package, version, source, what was declared, the scan result at install, and any revocation date |
| `ethos plugin revoke <pluginId>` | Withdraws the grant. The record is kept with a `revokedAt` date rather than deleted |

Revocation prevents the **next** load and blocks lockfile auto-install. It cannot claw back anything an already-loaded plugin did — that code has already run as the user.

- Source: `extensions/plugin-loader/src/grants.ts`
- Record: `<pluginsDir>/grants.json`
- Load-path gate: `extensions/plugin-loader/src/index.ts`

### MCP environment minimization {#mcp-environment-minimization}

*Status: Shipped.*

When Ethos spawns a stdio MCP server, the child's environment is built from an allowlist, not from the parent's environment minus a denylist (`buildMcpEnv`, called from `extensions/tools-mcp/src/index.ts`):

| Variable | Child receives |
|---|---|
| `PATH`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL` | Passed through |
| Names listed in the server's `mcpEnvPassthrough` | Passed through |
| A name matching `KEY`, `TOKEN`, `SECRET` or `PASSWORD` as a `_`-separated word | Dropped, unless listed in `mcpEnvPassthrough` |
| `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` | Set to a persistent per-server directory, `~/.ethos/mcp-runtime/<serverId>/` (mode `0700`); the server's own `env` config cannot override them (`PINNED_MCP_KEYS`) |
| Everything else | Dropped |

Limitation: this changes what the child **inherits**, not what it can read. The MCP server runs as your user, and a server that opens `/Users/<you>/.aws/credentials` by absolute path still reads it.

- Source: `packages/safety/scanner/src/mcp-env.ts`

### Allowed skill permissions {#allowed-skill-permissions}

*Status: Shipped.*

`safety.allowed_skill_permissions` limits the **permissions** a skill may declare, per category. It is not a list of tool names.

```yaml
safety:
  allowed_skill_permissions:
    fs_read: ["~/notes"]
    fs_write: false
    network: ["api.github.com"]
    mcp_env_passthrough: false
```

Each of `fs_read`, `fs_write`, `network` and `mcp_env_passthrough` takes a list (only those values), `true` (any value), or `false` / absent (none). `checkSkillPermissions` in `extensions/skills/src/ingest-filter.ts` compares each value a skill declares against the policy and omits the skill (`{ include: false, reason }`) on the first disallowed value. There is no typed error. When the personality declares no `allowed_skill_permissions` block at all, declared permissions are only warned about, not enforced. `mcp_env_passthrough` is deny-by-default when the block is present (`deriveSkillPassthrough`).

A skill's `required_tools` is a separate check: every required tool must be in the personality's effective tool reach — its toolset plus the tools of its attached MCP servers and plugins — or the skill is omitted (`toolNamesForPersonality` in `packages/core/src/tool-registry.ts`, applied in `ingest-filter.ts`).

- Source: `extensions/skills/src/ingest-filter.ts`; `allowed_skill_permissions` in `packages/types/src/personality.ts`

## Audit substrate — observability.db {#audit-substrate}

*Status: Shipped (write path and the categories marked emitted). Not shipped (`audit.transition`, `audit.redacted`, policy snapshots).*

Safety events land in `observability.db` as typed events. `EventCategory` is a string (`packages/types/src/observability.ts`); the Ethos vocabulary is `ETHOS_EVENT_CATEGORIES` in `packages/wiring/src/observability/ethos-observability.ts`.

| Category | Emitted today? | What it records |
|---|---|---|
| `audit.approval` | Yes | Operator approved or denied a tool call, with sender attribution (`recordSafetyApproval`) |
| `audit.block` | Yes | Any safety refusal. The `code` field says which: `tool_blocked` (hook refusal, including hardline), `tool_downgraded_post_untrusted_read`, `injection_detected`, `injection_classifier_failed`, `channel.allowlist.blocked`, `channel.mention_gate`, and others |
| `audit.watcher` | Yes | Watcher paused or terminated a turn (`recordWatcherDecision`) |
| `audit.injection_flag` | Yes, gateway only | Tier 1 matched an inbound channel message (code `channel.injection_detected`) or a background-job summary. Flags on tool results are `audit.block` / `injection_detected` instead |
| `channel.pairing` | Yes, gateway only | Pairing code issued; `/allow` failed (`Gateway.recordPairing`) |
| `channel.allow` / `channel.deny` | Yes, gateway only | Owner approved a pairing code / ran `/deny` |
| `install.scan` | Yes, on the CLI install paths and learning promotion | Skill or plugin scan decision (`installScanEvent`); see [Static-analysis pattern scanner](#static-analysis-pattern-scanner) for the paths not covered |
| `install.event` | Yes | Agent-mesh journal entries and `ethos data reset` |
| `audit.transition` | **No** | `recordSafetyTransition` exists; nothing calls it. `ethos audit` and the support bundle filter on it and find nothing |
| `audit.redacted` | **No** | `recordRedacted` exists; nothing calls it |

The store uses STRICT-mode SQLite tables in WAL mode with `synchronous = NORMAL` (see the durability table in `CLAUDE.md`). It has no FTS5 index. Retention is set per **domain prefix**, not per category, with `retention.events.<domain>` lines in `~/.ethos/config.yaml`, and a per-personality override with `personalities.<id>.retention.events.<domain>` lines in the same file:

| Prefix | Default retention |
|---|---|
| `error` | 90 days |
| `audit.*` | 365 days |
| `channel.*` | 365 days |
| `install.*` | Forever |

Policy snapshots are **not written today**. The snapshot table and `recordSnapshot` exist in `extensions/observability-sqlite/src/service.ts`, but nothing calls `recordSnapshot` and `startTurnTrace` is never given a `snapshotId`. You cannot yet reconstruct a personality's network policy at the time of an event from the store.

- Source: `extensions/observability-sqlite/src/store.ts`, `extensions/observability-sqlite/src/service.ts`, `extensions/observability-sqlite/src/retention.ts`

## Cron output path containment {#cron-output-path-containment}

*Status: Shipped (lexical containment). Not covered (symlinks).*

`CronScheduler.readRunOutput()` and `readRunProgress()` read only paths inside the scheduler's `outputDir`. `assertInOutputDir` resolves the path and refuses it when the path relative to `outputDir` starts with `..` or is absolute. A path that contains `..` but resolves inside `outputDir` is allowed. The check is lexical: it does not walk symlinks, so a link inside `outputDir` that points elsewhere is followed.

- Source: `assertInOutputDir` in `extensions/cron/src/index.ts`
- Tests: `extensions/cron/src/__tests__/cron.test.ts`, `extensions/cron/src/__tests__/run-progress.test.ts`

## Web dashboard and admin authentication {#admin-panel-token-auth}

*Status: Shipped.*

The web API accepts two credentials. There is no `ethos token create` command and no OS-keychain token store on the server.

| Credential | How it is issued | Where it is accepted | Enforced by |
|---|---|---|---|
| `ethos_auth` cookie | `ethos serve` prints a one-time `?t=<token>` URL. `GET /auth/exchange` checks it, rotates the stored token, and sets the cookie (`HttpOnly`, `SameSite=Strict`) | `/rpc/*`, `/sse/*`, `/openapi/*`, `/setup/whatsapp/*`, and the voice, satellite and takeover WebSockets | `authRoutes` in `apps/web-api/src/routes/auth.ts`; `authMiddleware` in `apps/web-api/src/middleware/auth.ts`; `dualAuth` in `apps/web-api/src/middleware/dual-auth.ts` |
| Bearer API key (`sk-ethos-…`) | `ethos api-key create --name <label> [--scopes <a,b>]` (default scope `chat`), or the web Settings page through the `apiKeys.create` RPC. Stored hashed in `sessions.db` by `SqliteApiKeyStore` (`extensions/session-sqlite/src/api-key-store.ts`) | `/rpc/*` and `/sse/*` methods whose namespace maps to the key's scope in `SCOPE_MAP`, plus the OpenAI-compatible `/v1/*` surface (scope `chat`), `/metrics` (`metrics:read`) and `/cron/fire` (`cron`) | `dualAuth` and `resolveScope` in `apps/web-api/src/middleware/dual-auth.ts`; `bearerAuth` in `apps/web-api/src/middleware/bearer-auth.ts` |

A request with neither credential receives `401 Unauthorized`. A bearer key is refused with `403 Forbidden` in these cases:

- **Unmapped namespaces.** Any namespace absent from `SCOPE_MAP`, which includes `admin` and `outbox`, is cookie-only. `dualAuth` fails closed on it.
- **Cookie-only methods.** Methods mapped to `COOKIE_ONLY`, such as `personalities.create` and `tools.test`, reject every bearer key.
- **The `apiKeys` namespace.** A bearer key cannot mint or revoke keys. `cookieOnlyGuard` refuses it at the route, and `dualAuth` refuses it again.
- **Missing scope.** A key without the method's required scope is refused.

The `admin` namespace has a second gate. Every admin procedure calls `requireAdmin` (`apps/web-api/src/services/admin.service.ts`), which returns `403` unless `admin.enabled: true` is set in `~/.ethos/config.yaml`. The default is disabled.

When `ethos serve` is not given an API-key store, `/rpc/*` and `/sse/*` fall back to `authMiddleware`, which accepts the cookie only (`apps/web-api/src/routes/index.ts`).

- Pinned by: `apps/web-api/src/__tests__/routes/auth-and-rpc.test.ts` (cookie exchange, rotation, `401` without a cookie), `apps/web-api/src/__tests__/middleware/dual-auth-scope.test.ts` (fail-closed and cookie-only methods), `apps/web-api/src/__tests__/middleware/apikeys-auth-bypass.test.ts` (`apiKeys` namespace), `apps/web-api/src/__tests__/routes/admin.test.ts` (`admin.enabled` gate)
- Limitation: no test sends a bearer key to an `admin` procedure. The refusal comes from the generic unmapped-namespace branch in `dualAuth`, which `dual-auth-scope.test.ts` exercises through `outbox`.
- Cross-ref: [Authenticate your dashboard users](../building/how-to/authenticate-dashboard-users.md)

## Read-only plugin data source access {#read-only-sql}

*Status: Shipped.*

Plugin data sources expose SQLite databases to the dashboard. Read-only enforcement lives at the SQLite connection, not in a keyword filter: both query paths open the database with `new Database(dbPath, { readonly: true })`, so the engine refuses every write regardless of what the statement text says.

Connection-level read-only is the stronger property. A denylist of write keywords is a guess about what a string means, and SQL offers cheap ways to make a write not look like one — a leading comment, unexpected casing, a `WITH` prefix, or a keyword that never appears at the position the filter inspects. A connection opened read-only does not interpret intent; SQLite refuses the write at execution.

| Layer | Where | What it does |
|---|---|---|
| Read-only connection | `runPluginQuery` in `dashboards.service.ts`; `refreshSinglePanel` in `dashboard-refresh.ts` | Engine-level refusal of all writes. Covers both query paths. |
| SELECT-only statement guard | `assertSelectOnlySql` in `interpolate-params.ts` | Write-time. Requires a single statement beginning with `SELECT`, and rejects embedded `;`. `addPanel` applies it to every SQL panel, and `updatePanel` applies it whenever a patch sets `sqlQuery`. |
| Param allowlist | `findInvalidParamKeys` in `interpolate-params.ts` | Values interpolated into panel SQL must match a declared `select`/`options` option or a `YYYY-MM-DD` date. Template positions cannot be `?`-bound, so this allowlist is the injection defense on that path. |
| Keyword prefix denylist | `MUTATING` in `runPluginQuery` | Ad-hoc `dashboards.runQuery` RPC only. Rejects eight leading keywords. It tests only the statement's first word — a usability guard, not a boundary. |

Both paths that read a plugin data source carry the read-only connection: `runPluginQuery`, behind the ad-hoc `dashboards.runQuery` RPC, and `refreshSinglePanel`, behind scheduled and manual panel refresh. There is no third path — `getDataSourcePath` in `extensions/plugin-loader/src/index.ts` has exactly these two callers.

Registration itself is not validated. `registerDataSource(id, path)` (`PluginApiImpl` in `packages/plugin-sdk/src/index.ts`) records whatever identifier and filesystem path the plugin passes, with no path containment, extension check, or identifier constraint. A plugin can therefore point a data source at any SQLite file the host process can open. That is consistent with the plugin trust model — plugin code already runs in-process — but it means the boundary here is read-only access, not restricted reach.

- Source: `extensions/dashboard/src/dashboards.service.ts`, `extensions/dashboard/src/dashboard-refresh.ts`, `extensions/dashboard/src/interpolate-params.ts`
- Cross-ref: [Register a plugin data source](../building/how-to/register-plugin-data-source.md)

## Desktop remote connection security {#desktop-remote-connection}

*Status: Shipped.*

When Mission Control connects to a remote Ethos instance, the web token is encrypted with Electron `safeStorage` (whose key the OS keychain holds) and stored in the app's `keychain.json`, not in plaintext config (`apps/desktop/src/main/keychain.ts`). The main process writes it onto the remote origin as the `ethos_auth` cookie before navigating; the window then loads the remote server's own SPA same-origin, so there is no cross-origin request to authorize. `/auth/exchange` is deliberately not used — it rotates the token, which would invalidate the stored value on every launch.

The renderer never receives the token itself. The `keychain:preview` IPC returns a masked preview — the first 3 and last 4 characters — for display (`maskApiKey` in `apps/desktop/src/main/ipc.ts`).

- Source: `apps/desktop/src/main/connection.ts`, `apps/desktop/src/main/keychain.ts`
- Cross-ref: [Deploy Mission Control with a remote Ethos](../building/how-to/deploy-mission-control-remote.md)

## Removed empty safety stubs {#removed-empty-safety-stubs}

Five directories under `extensions/` carried safety-package names and shipped no code: `safety-injection/` and `safety-scanner/`, removed earlier, and `safety-channel/`, `safety-network/`, and `safety-watcher/`, removed in this release. All five are gone. The real implementations live under `packages/safety/` — `injection/`, `scanner/`, `channel/`, `network/`, `watcher/`, `redact/`, and `groundtruth/` — which are the source paths listed throughout this page and the Tier 0 members named in [the security boundary](./security-boundary.md#tiers).

Empty directories with kernel names in the extensions tree are not cosmetic. They point a reader looking for the kernel at the wrong tier, which is the one thing the tier roster exists to prevent.

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

## See also {#see-also}

- [What does Ethos guarantee, and what is outside its security boundary?](./security-boundary.md) — which of these controls are published guarantees, and which are not.
- [How does Ethos defend against the threats it knows about?](./overview.md) — the layered model and runtime precedence.
- [What is the threat model?](./threat-model.md) — what each control is defending against.
- [Pre-launch hardening pass](./security-fixes.md) — the issues a pre-launch review surfaced and how each was folded in.
- [Responsible disclosure](./responsible-disclosure.md) — how to report a control bypass.
