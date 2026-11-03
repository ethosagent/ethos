---
title: "Set up approval gates for dangerous tool calls: approval surfaces"
description: "What the approval prompt looks like in the CLI, web UI, chat bots and unattended runs, and where it is refused."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Learn what a flagged tool call does on each surface your personality runs on, and where nobody can answer it.

## Result

You know which prompt appears on the CLI, web UI and chat bots, who can answer it, and which runs refuse a flagged call instead.

## Prereqs

- Complete [steps 1-4](../set-up-approval-gates.md): a personality with `safety.approvalMode` set.

## 5. Know what approval looks like on each surface

The mode is the same across surfaces. The *prompt* differs by what the surface can render.

### CLI and TUI (`ethos chat`)

A flagged call pauses the turn and asks you in the terminal. The readline REPL prints the tool, the flagged reason and a preview of the arguments, then reads one line:

```
approval needed · terminal
  reason  terminal requires explicit approval (command substitution)
  args    {"command":"kill $(lsof -t -i:3000)"}
Allow? [y/N]
```

Type `y` or `yes` to run the call. Anything else — `n`, an empty Enter, any other text — refuses it, and the agent gets the refusal back as a tool error. The TUI shows the same three lines in a modal: `y` allows, and `n`, Esc or Enter refuse. Secrets in the arguments are redacted and the preview is cut at 300 characters (`formatApprovalArgsPreview` in [apps/ethos/src/terminal-approval.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/terminal-approval.ts)).

The gate is `wireTerminalApprovalGate` in that file. It uses the same danger check as the web UI and the chat cards (`createApprovalDangerPredicate`), so the same calls are flagged, and it reuses the chat cards' coordinator for the timeout and the audit trail. It is pinned by `apps/ethos/src/__tests__/terminal-approval.test.ts` and `apps/tui/src/__tests__/approval-modal.test.ts`.

- **Parallel calls queue.** When a turn flags two calls, you answer them one at a time, oldest first. The TUI shows how many more are waiting.
- **Piped output still shows the prompt.** When stdout is not a terminal (`ethos chat | tee chat.log`) but stdin is, the question and its preview are written to stderr, so you see what you are answering.
- **Ctrl-C refuses.** In the readline REPL, Ctrl-C refuses every waiting call and aborts the turn.
- **A hardline command is never asked about.** It is refused at once with its hardline reason: no answer could let it run.
- **A call that cannot run is never asked about.** A tool outside the personality's `toolset`, `mcp_servers` or `plugins`, or outside a `--toolsets` flag, is refused at once with the reason it would be refused later (`AgentLoop.isToolPermitted` through `notPermittedRefusal` in `packages/wiring/src/approval-seams.ts`, and `cliToolsetsRefusal` in `apps/ethos/src/cli-overrides.ts`). The Slack, Telegram and Discord cards and the web modal skip it the same way.
- **Command substitution can be approved.** `kill $(lsof -t -i:3000)` asks instead of being refused: the gate marks the loop (`markHostApprovalGate`), and the terminal guard then leaves such a command to the gate.
- **There is no "allow for this session".** Each call is asked on its own. The one-hour lease exists only in the web UI.

Where nobody can answer, a flagged call is refused with a reason that says so:

- `ethos chat -q "<query>"` — a one-shot run has no prompt.
- `ethos chat` with piped stdin — there is no keyboard to answer from.
- `ethos acp` — the ACP server does not send `session/request_permission` to its client, so it cannot ask.
- `ethos -z`, `ethos batch`, `ethos eval`, `ethos cron run` and `ethos cron daemon`, `ethos personality judge` and the nightly scoring pass, `ethos bench`, and `ethos mcp serve` without `--personality` — none of them has a prompt (`gateNonInteractiveLoop` in [apps/ethos/src/lib/non-interactive-approval.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/non-interactive-approval.ts), pinned by `apps/ethos/src/__tests__/non-interactive-approval.test.ts`). A cron job follows the same rule wherever it runs: under `ethos cron run` and `ethos cron daemon`, as on the gateway's cron/dream loop, `approvalMode: off` auto-approves a flagged call only when `allowUnattendedDangerousTools: true` is set in `config.yaml` (`gateCronLoop` in the same file, which reuses `wireUnattendedApprovalGate`; pinned by `apps/ethos/src/__tests__/cron-approval-parity.test.ts`).

```
terminal needs approval, and stdin is not a terminal, so nobody can answer a prompt (terminal requires explicit approval). Run `ethos chat` in an interactive terminal to be asked, or use the web UI.
```

On a host-local execution posture, `terminal`, `process_start`, `run_tests` and `lint` are flagged in every mode, so on these runs they are refused unless the personality uses `approvalMode: off` or runs on a docker posture.

### Web UI (`ethos serve`)

The web UI ships the full flow. A `dangerous` call posts an approval card anchored to the personality bar (`apps/web/src/components/chat/ApprovalModal.tsx`) with the tool name, reason, and a JSON-formatted args preview. You pick one of three scopes:

- **Just this command** — allow this single invocation, ask again next time.
- **This exact command** — allow this tool with these exact arguments forever, for this personality.
- **Any args for this tool** — allow every future invocation of this tool by this personality.

A stored grant belongs to the personality whose call you approved: another personality asking for the same tool still gets a card (`AllowlistRepository.matches`, pinned by `apps/web-api/src/__tests__/services/approvals-scoping.test.ts`). Grants saved before this scoping existed are kept in `allowlist.json` but match nothing, so each one asks once more.

Allow or Deny resolves the suspended `before_tool_call` hook. The card updates in place to show the outcome.

Hardline commands (a `terminal` or `process_start` command on the blocklist, such as `rm -rf /`) are different on the web: the web profile asks rather than blocks, so they do reach the card — but it offers only **Just this command**. No stored grant and no one-hour lease can approve a hardline command; you approve each one yourself, every time (`ApprovalsService.requestApproval` and `ApprovalsService.approve`, pinned by `apps/web-api/src/__tests__/services/approvals-hardline.test.ts`).

### Slack, Telegram and Discord

These adapters implement `ApprovalCapableAdapter` and post an interactive approval card with Allow / Deny buttons in the originating conversation (DM or channel). The flow is wired in [apps/ethos/src/commands/gateway.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts). Only one user can decide each card, and clicks from anyone else are ignored:

- In a DM, the user whose message triggered the turn decides.
- In a group chat, the platform owner decides when `channel_filter.<platform>.ownerUserId` is set in `config.yaml`. The member who asked cannot approve their own call.
- In a group chat on a platform with no owner configured, the user whose message triggered the turn decides.

`resolveApprovalTarget` in `wireApprovalFlow` picks the decider, pinned by `apps/ethos/src/commands/__tests__/approval-target.test.ts`. The card updates in place to show who decided what.

Threads work on Slack (the card posts in the same thread as the inbound message). On Telegram the card posts as a reply to the triggering message.

### WhatsApp, email and webhook bots

These have no approval card to post, so nobody can be asked. A call that would need approval is always refused with `<tool> needs approval, and this chat surface cannot show an approval prompt (<reason>). Use a platform with approval cards (Slack, Telegram, Discord) or the web UI.` The same applies to a turn that reaches a Slack, Telegram or Discord bot's agent through an adapter without cards (an email that falls back to that bot, for example). Unflagged tools run as usual. `wireApprovalFlow` in [apps/ethos/src/commands/gateway.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts) wires this for `ethos gateway start` and `ethos boot`. It is pinned by `apps/ethos/src/commands/__tests__/approval-flow-unattended.test.ts`.

No setting lets these bots run a flagged tool. `approvalMode: off` and `allowUnattendedDangerousTools: true` apply only to unattended cron loops — the gateway's cron/dream loop and `ethos cron run` / `ethos cron daemon` — because a remote sender drives every turn on a chat bot. To use a flagged tool from chat, talk to the agent through Slack, Telegram, Discord or the web UI, where you are asked first.

This also holds with no bot configured. `ethos gateway start` then runs channel-plugin chats on the cron/dream loop itself, and `wireUnattendedApprovalGate` in [apps/ethos/src/unattended-approval-gate.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/unattended-approval-gate.ts) tells them apart per call. A chat turn gets the chat-bot refusal above, and cron jobs on the same loop keep the opt-in. It is pinned by `apps/ethos/src/__tests__/unattended-approval-gate.test.ts`.

## Verify

- In the web UI, give a personality **Any args for this tool** on `terminal`, then ask it to run a hardline-matching command (e.g. `rm -rf ~/.ssh`) — a card still appears, offering only **Just this command**, confirming no stored grant can approve a hardline command.
- In `ethos chat` with `approvalMode: manual`, ask the personality to run `kill $(lsof -t -i:3000)` — the `approval needed · terminal` prompt appears and waits for `y` or `N`.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `<tool> needs approval, and <reason nobody can answer> (…)` | The run cannot show a prompt: `ethos chat -q`, piped stdin, `ethos acp`, or one of the non-interactive commands listed in step 5. | Run `ethos chat` in an interactive terminal, use the web UI, or set `approvalMode: off` on a personality you only use locally. |
| Slack / Telegram / Discord card never appears for a `dangerous` call | The adapter is wired but the personality is not bound to that bot, or the `dangerous` classification did not fire. | Confirm the bot binding in `~/.ethos/config.yaml`. Under `manual` and `off` a card is posted only for `skills_pending_approve`, `skills_pending_reject` and `call` (`APPROVAL_SURFACE_ALWAYS_ASK`), for `terminal`, `process_start`, `run_tests` and `lint` on a host-local posture (`LOCAL_POSTURE_CONSEQUENTIAL_TOOLS`), and for shell commands using `$(…)` or backticks (`approvalRequiredReason`). A hardline command never gets a card: it is refused at once with its hardline reason (`createSlackApprovalHook` in `apps/ethos/src/approval-coordinator.ts`), because the terminal and process guards would refuse it whatever the card said. Switch to `approvalMode: smart` to add the four consequential tools. |

**Long-running tools.** Approval suspends the `before_tool_call` hook. The turn sits idle until you decide, or until the approval times out. After 10 minutes with no decision the call is denied with the reason `approval timed out`. The web modal enforces this in `ApprovalsService.requestApproval` (`apps/web-api/src/services/approvals.service.ts`). The chat cards and the `ethos chat` prompt enforce it in `ApprovalCoordinator.requestApproval` (`apps/ethos/src/approval-coordinator.ts`). To change the window for both, set `approvalTimeoutMs` in `~/.ethos/config.yaml`. With `approvalTimeoutMs: 0` there is no timeout, and the call waits until someone decides or the process shuts down. Starting a new session with `/new` does not release a pending approval.

**Async approval on channels.** Slack and Telegram approvals are not time-bounded either. A button left unclicked holds the turn open until the session ends. For DMs that means one user one decision; for channels it means whoever triggered the turn is the only one whose click counts.

## See also

- [Set up approval gates](../set-up-approval-gates.md) — steps 1-4 and the rest of the troubleshooting table.
- [Security overview](../../../security/overview.md) — where approval gates sit in the trust model.
