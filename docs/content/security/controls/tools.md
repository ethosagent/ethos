---
title: "Security controls: tool-level controls"
description: "Toolset enforcement, hardline blocklist, risk classifier and approvals."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

Per-personality toolset enforcement, the hardline blocklist, the risk classifier and the approval modal. Part of the [Security controls](../controls.md).

## Tool-level controls {#tool-level-controls}

### Per-personality toolset enforcement {#per-personality-toolset-enforcement}

*Status: Shipped.*

The personality's `toolset.yaml` is a hard allowlist for **built-in** tools, enforced at the framework layer. `DefaultToolRegistry.toDefinitions(allowedTools)` filters the [tool](../../getting-started/glossary.md#tool) list the LLM sees, and `executeParallel` rejects calls outside the allowlist with a `tool_result` carrying `is_error: true` (preserving the Anthropic message contract).

Three kinds of tool are not gated by `toolset.yaml`:

| Tool kind | Gated by |
|---|---|
| MCP tools (`mcp__<server>__<tool>`) | The personality's MCP server allowlist and per-server tool allowlist (`passesFilter`) |
| Plugin tools | The personality's `plugins` allowlist (`passesFilter`) |
| Tools that set `alwaysInclude` | Nothing at the toolset layer; only the surface's `excludeTools` removes them |

- Source: `toDefinitions` and `passesFilter` in `packages/core/src/tool-registry.ts`
- Example: the built-in `researcher` personality's `toolset.yaml` has no `terminal` (the shell tool), so a [skill](../../getting-started/glossary.md#skill) that tells it to run a command cannot: the tool never reaches the model.

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

The pattern check and the LLM classifier in `packages/safety/injection/` do not judge tool calls. They check the *results* of tools that declare `outputIsUntrusted` (`handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`). See [Two-tier classifier](injection-watcher-redaction.md#two-tier-classifier).

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

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.
