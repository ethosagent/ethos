---
title: Set up approval gates for dangerous tool calls
description: Configure the safety.approvalMode knob so dangerous tool calls pause for human review instead of firing unsupervised.
kind: how-to
audience: user
slug: set-up-approval-gates
time: 10 min
updated: 2026-09-25
---

Some tool calls write files, run shell commands, or hit the network. You do not want them firing unsupervised. Approval gates make the agent pause and ask before the dangerous call runs — or refuse it outright.

## Task

Configure a [personality](../../getting-started/glossary.md#personality)'s `safety.approvalMode` so the agent pauses (or doesn't) before a dangerous tool call.

## Result

The chosen personality routes every `dangerous` classification through the chosen mode — modal prompt, reviewer-judged auto-approval, or auto-fire — while the `blocked` hardline floor continues to refuse the worst commands no matter what.

## Prereqs

- A personality you own at `~/.ethos/personalities/<id>/` (built-ins shadow safely — copy with `ethos personality duplicate <built-in> <id>` if you want to override).
- Familiarity with the [personality config reference](../reference/personality-yaml.md).

## 1. Pick the right mode for the surface

Ethos's safety classifier sorts every tool call into one of three buckets. `safe` calls auto-fire. `blocked` calls are refused unconditionally — they are the hardline floor in [extensions/tools-terminal/src/guard.ts](https://github.com/ethosagent/ethos/blob/main/extensions/tools-terminal/src/guard.ts) (recursive `rm -rf /` or `~`, `dd of=/dev/sdX`, `mkfs`, `chmod` with setuid, writes to `/etc/sudoers` or `~/.ssh/authorized_keys`, `DROP TABLE`, fork bombs, etc.). `dangerous` calls are the middle band — destructive enough to want a human in the loop, not so destructive that they should never run.

`safety.approvalMode` decides what happens to that middle band.

| Mode | What happens on `dangerous` | When to pick it |
|---|---|---|
| `manual` *(default)* | Surface an approval prompt; wait for Allow / Deny. | Web UI, `ethos chat` (readline prompt or TUI modal), and Slack / Telegram / Discord bots. Any time you can answer a prompt in seconds. Where nobody can answer — `ethos chat -q`, piped stdin, `ethos -z`, `batch`, `eval`, `cron`, `bench`, `ethos mcp serve`, ACP — the call is refused instead (see step 5). |
| `smart` | An LLM reviewer judges the call first. `approve` → runs with no prompt. `deny` and `ask` → the approval prompt still fires, carrying the reviewer's reason. | Long-running agent sessions where approval fatigue is the failure mode. Trades latency and reviewer tokens for fewer interruptions. |
| `off` | Auto-fire. `blocked` calls still refuse. | Trusted local automation only — cron, batch runs, headless test rigs. Refused at config load when combined with any channel ingress. On the gateway's cron/dream loop it takes effect only when the operator also sets `allowUnattendedDangerousTools: true` in `config.yaml`; otherwise flagged calls there are refused, because nobody is present to approve them. In `ethos chat` and the other CLI commands (`-z`, `batch`, `eval`, `cron`, `bench`, `mcp serve`, `acp`) it takes effect as is, except that a command using `$(…)` or backticks is still asked about (or refused where nobody can be asked). It never takes effect in the web UI or on any chat bot: there `off` behaves like `manual`. |

The hardline `blocked` floor is **non-overridable** — `approvalMode: off` does not unlock `rm -rf /`. That is the point: a regex floor catches the literal command shape even when every other check is bypassed.

## 2. Add the YAML

Open `~/.ethos/personalities/<id>/config.yaml` and add a `safety` block. The shape lives in [packages/types/src/personality.ts](https://github.com/ethosagent/ethos/blob/main/packages/types/src/personality.ts):

```yaml
safety:
  approvalMode: manual
```

`smart` and `off` are the other two legal values. Anything else throws at config load:

```
Invalid approvalMode: "ask". Expected one of: manual, smart, off
```

### Turn on smart mode

```yaml
safety:
  approvalMode: smart
```

Under `smart` — and only under `smart` — four built-in tools are flagged as consequential and routed to the reviewer: `terminal`, `write_file`, `patch_file`, and `process_start` (`SMART_MODE_CONSEQUENTIAL_TOOLS` in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts)). Read-only tools such as `read_file`, `search_files`, and `web_search` are deliberately excluded: flagging a lookup would buy a reviewer round-trip per read and no safety. `run_code` is excluded too, because it already executes inside an isolated container.

`manual` and `off` flag three things, all from `createDangerPredicate` in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts):

- The tools the surface passes as `alwaysAsk`. Every approval surface passes `APPROVAL_SURFACE_ALWAYS_ASK`: `skills_pending_approve`, `skills_pending_reject` and `call`.
- `terminal`, `process_start`, `run_tests` and `lint` when the personality runs on a host-local posture that is not itself a container (`LOCAL_POSTURE_CONSEQUENTIAL_TOOLS`).
- A `terminal`, `process_start`, `run_tests` or `lint` command that uses command substitution, `$(…)` or backticks, on any posture (`approvalRequiredReason`).

`smart` flags all of these plus its four tools. Switching a personality to `smart` therefore widens what gets gated, it does not narrow it. Hardline commands sit outside this set: they are refused before any mode applies.

Four things worth knowing before you rely on it:

- **The reviewer fails closed.** A provider error, a round-trip over 15 seconds, or a response that isn't the expected JSON all resolve to `ask` — which routes to the normal approval prompt. No failure path returns `approve`.
- **Verdicts are cached per exact call**, keyed on `sha256(tool name + canonicalized args)`. Approving `rm -rf ./build` does not approve `rm -rf ./src`; re-issuing the identical call costs no second review.
- **Hardline `blocked` commands never reach the reviewer.** They short-circuit ahead of it, so no verdict can auto-approve one.
- **Smart mode is wired on every surface with an approval gate** — `ethos serve`, `ethos gateway`, the desktop app, `ethos chat` and `ethos acp`. A call the reviewer does not approve still needs a human, so it is refused where nobody can be asked.

### Deny rules

`safety.denyRules` is a list of case-sensitive substrings matched against `<tool-name> <canonical-json-args>`, so the rule `git push --force` matches a `terminal` call whose `command` contains that text. A match refuses the call outright with the reason `denied by personality deny rule: git push --force`.

Write the list under the same `safety` block:

```yaml
safety:
  approvalMode: smart
  denyRules:
    - git push --force
    - rm -rf ./dist
```

Malformed lists throw at load rather than loading half-parsed — a safety field that silently accepts garbage reads as protection while gating nothing:

```
Invalid denyRules: "git push --force". Expected a list of match strings
Invalid denyRules entry: empty rule. Every entry must be non-empty
```

Empty and whitespace-only entries are refused for the same reason from opposite ends: `""` can never match, and `" "` matches every call, because the match subject always contains a space between the tool name and its arguments.

Deny rules are the floor. They are matched **before** any approval check runs, so a rule binds in every mode — including `approvalMode: off` with auto-approve enabled — and on every surface, including `ethos chat` and cron. This inverts the usual precedence intuition: modes can only make a call stricter, never looser. A matched call never reaches an approval prompt: no card or modal is posted, no stored allowlist grant applies, and nobody can Allow it. To let a call through, remove the rule.

## 3. Reload the personality

Personalities are mtime-cached. Save `config.yaml` and the next turn picks up the new mode — no restart, no `/new`. Confirm with:

```
ethos personality show <id> --json | jq .config.safety
```

```json
{
  "approvalMode": "smart"
}
```

The rendered character sheet (`ethos personality show <id>` without `--json`) covers routing, memory, toolset, and filesystem reach — it does not print the safety block. Use `--json` to audit approval mode.

## 4. Refuse the unsafe combination

`approvalMode: off` paired with any of `platform: telegram | discord | slack | whatsapp | email` is rejected at config load:

```
personality "deploy-bot" has approvalMode: off but is bound to channel "telegram".
       Remote senders + auto-approve = remote-driven destructive actions.
       Either: (a) move approvalMode to 'smart' or 'manual', or
               (b) remove channel bindings from this personality (cli/cron only).
       This combination is not configurable; it is rejected at config load.
```

The check lives in [extensions/personalities/src/index.ts](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts) and runs every time the personality loads. There is no flag to override it. A bot that takes input from strangers and auto-approves destructive actions is the catastrophic combination; the framework refuses to boot it.

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
- **A call that cannot run is never asked about.** A tool outside the personality's `toolset`, `mcp_servers` or `plugins`, or outside a `--toolsets` flag, is refused at once with the reason it would be refused later (`AgentLoop.isToolPermitted` through `notPermittedRefusal` in `apps/ethos/src/approval-coordinator.ts`, and `cliToolsetsRefusal` in `apps/ethos/src/cli-overrides.ts`). The Slack, Telegram and Discord cards skip it the same way.
- **Command substitution can be approved.** `kill $(lsof -t -i:3000)` asks instead of being refused: the gate marks the loop (`markHostApprovalGate`), and the terminal guard then leaves such a command to the gate.
- **There is no "allow for this session".** Each call is asked on its own. The one-hour lease exists only in the web UI.

Where nobody can answer, a flagged call is refused with a reason that says so:

- `ethos chat -q "<query>"` — a one-shot run has no prompt.
- `ethos chat` with piped stdin — there is no keyboard to answer from.
- `ethos acp` — the ACP server does not send `session/request_permission` to its client, so it cannot ask.
- `ethos -z`, `ethos batch`, `ethos eval`, `ethos cron run` and `ethos cron daemon`, `ethos personality judge` and the nightly scoring pass, `ethos bench`, and `ethos mcp serve` without `--personality` — none of them has a prompt (`gateNonInteractiveLoop` in [apps/ethos/src/lib/non-interactive-approval.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/non-interactive-approval.ts), pinned by `apps/ethos/src/__tests__/non-interactive-approval.test.ts`). A cron job run by `ethos cron` honours `approvalMode: off` without `allowUnattendedDangerousTools`; a cron job run by the gateway does not.

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

No setting lets these bots run a flagged tool. `approvalMode: off` and `allowUnattendedDangerousTools: true` apply only to the gateway's cron/dream loop, because a remote sender drives every turn on a chat bot. To use a flagged tool from chat, talk to the agent through Slack, Telegram, Discord or the web UI, where you are asked first.

This also holds with no bot configured. `ethos gateway start` then runs channel-plugin chats on the cron/dream loop itself, and `wireUnattendedApprovalGate` in [apps/ethos/src/unattended-approval-gate.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/unattended-approval-gate.ts) tells them apart per call. A chat turn gets the chat-bot refusal above, and cron jobs on the same loop keep the opt-in. It is pinned by `apps/ethos/src/__tests__/unattended-approval-gate.test.ts`.

## Verify

- `ethos personality show <id> --json | jq .config.safety` — prints `{"approvalMode": "<mode>"}`.
- Save `approvalMode: off` on a personality with `platform: telegram` — the next personality load throws the rejection above.
- Save `approvalMode: invalid` — the next load throws `Invalid approvalMode: "invalid". Expected one of: manual, smart, off`.
- In the web UI, give a personality **Any args for this tool** on `terminal`, then ask it to run a hardline-matching command (e.g. `rm -rf ~/.ssh`) — a card still appears, offering only **Just this command**, confirming no stored grant can approve a hardline command.
- On `approvalMode: smart`, ask the personality to write a file in the web UI. Either no card appears (the reviewer approved) or the card's reason reads `denied by reviewer: <one sentence>` — both confirm the reviewer ran.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid approvalMode: "X". Expected one of: manual, smart, off` | A typo in `config.yaml` — only the three literal values are accepted. | Pick `manual`, `smart`, or `off`. |
| `personality "X" has approvalMode: off but is bound to channel "telegram"` | `off` on a personality with `platform: telegram \| discord \| slack \| whatsapp \| email`. | Move to `smart` or `manual`, or remove the `platform` binding so the personality is CLI/cron only. |
| `dangerous` calls in `ethos chat` fire without prompting | The personality is on `approvalMode: off`, or the call is not flagged: on a docker posture `terminal` is flagged only under `smart` or when its command uses `$(…)` or backticks. | Check the mode with `ethos personality show <id> --json`. |
| `<tool> needs approval, and <reason nobody can answer> (…)` | The run cannot show a prompt: `ethos chat -q`, piped stdin, `ethos acp`, or one of the non-interactive commands listed in step 5. | Run `ethos chat` in an interactive terminal, use the web UI, or set `approvalMode: off` on a personality you only use locally. |
| Slack / Telegram / Discord card never appears for a `dangerous` call | The adapter is wired but the personality is not bound to that bot, or the `dangerous` classification did not fire. | Confirm the bot binding in `~/.ethos/config.yaml`. Under `manual` and `off` a card is posted only for `skills_pending_approve`, `skills_pending_reject` and `call` (`APPROVAL_SURFACE_ALWAYS_ASK`), for `terminal`, `process_start`, `run_tests` and `lint` on a host-local posture (`LOCAL_POSTURE_CONSEQUENTIAL_TOOLS`), and for shell commands using `$(…)` or backticks (`approvalRequiredReason`). A hardline command never gets a card: it is refused at once with its hardline reason (`createSlackApprovalHook` in `apps/ethos/src/approval-coordinator.ts`), because the terminal and process guards would refuse it whatever the card said. Switch to `approvalMode: smart` to add the four consequential tools. |
| `smart` mode prompts for everything anyway | The reviewer is failing closed — provider error, a round-trip over 15s, or a response that wasn't the expected JSON. Every one resolves to `ask`. | Check that the `model` and provider credentials in `~/.ethos/config.yaml` work; the reviewer runs on the primary model, so a broken primary breaks the reviewer. |

## Caveats

**Teams.** Each personality on a team applies its own `safety.approvalMode` independently. A `manual` engineer and an `off` (cron-only) batch member can coexist on the same board — the gate runs per `before_tool_call`, scoped to the loop that owns the turn. There is no team-level approval setting; the personality is the unit.

**Long-running tools.** Approval suspends the `before_tool_call` hook. The turn sits idle until you decide, or until the approval times out. After 10 minutes with no decision the call is denied with the reason `approval timed out`. The web modal enforces this in `ApprovalsService.requestApproval` (`apps/web-api/src/services/approvals.service.ts`). The chat cards and the `ethos chat` prompt enforce it in `ApprovalCoordinator.requestApproval` (`apps/ethos/src/approval-coordinator.ts`). To change the window for both, set `approvalTimeoutMs` in `~/.ethos/config.yaml`. With `approvalTimeoutMs: 0` there is no timeout, and the call waits until someone decides or the process shuts down. Starting a new session with `/new` does not release a pending approval.

**`approvalMode: off` auto-approves in two places only.** The danger predicate honours `off` only behind its `allowAutoApproveDangerousTools` capability (see the contract in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts)). Two callers pass it. The gateway's cron/dream loop gate, `wireUnattendedApprovalGate` in [apps/ethos/src/unattended-approval-gate.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/unattended-approval-gate.ts), passes it only when `allowUnattendedDangerousTools: true` is set in `config.yaml`. The terminal gate, `wireTerminalApprovalGate` in [apps/ethos/src/terminal-approval.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/terminal-approval.ts), always passes it, because `ethos chat` and the other CLI commands run on your own machine. Everywhere else `off` behaves exactly like `manual`. Configuring `off` still records intent, and it is the load-time signal that rejects the unsafe channel combination.

**Reviewer spend is not billed to the turn.** Smart-mode reviews consume tokens, and none of it lands in the turn's cost accounting or in `estimatedCostUsd` on the `usage` event. There is no path from a `before_tool_call` hook into `sessionCosts` — closing it means a contract change under `packages/types/`. The kanban completion verifier and the eval-harness scorers discard usage the same way. Volume is bounded rather than measured: the reviewer fires only for calls that already reached the danger band, and repeats are served from the verdict cache. Attribution is a follow-up.

**The reviewer runs on your primary model.** There is no `auxiliary.approvals` config block yet, so `smart` reviews cost primary-model tokens and primary-model latency — not the cheap-model bill the mode's name suggests. Budget for it before turning `smart` on with an expensive `model:` in `~/.ethos/config.yaml`.

**Three denials in a row stop the turn.** After three consecutive `before_tool_call` denials the loop emits a `halt` event (`Stopped: 3 tool calls denied in a row — retrying will not help`) and stops, on the theory that an agent that has been refused three times will not guess its way to an approval. The count is hard-coded — there is no config knob. Only approval denials advance it; a batch in which some tool actually ran restarts the count at that batch's denials instead of adding to the streak.

**Async approval on channels.** Slack and Telegram approvals are not time-bounded either. A button left unclicked holds the turn open until the session ends. For DMs that means one user one decision; for channels it means whoever triggered the turn is the only one whose click counts.

## See also

- [Personality config reference](../reference/personality-yaml.md) — every field on `safety:` and the rest of `config.yaml`.
- [What are the built-in personalities, and why these three?](../explanation/built-in-personalities.md) — how the built-ins handle approval modes by default.
- [Security overview](../../security/overview.md) — where approval gates sit in the trust model.
- [Slash commands reference](../reference/slash-commands.md) — `/personality` to switch the active role mid-conversation.
