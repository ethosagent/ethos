---
title: Set up approval gates for dangerous tool calls
description: Configure the safety.approvalMode knob so dangerous tool calls pause for human review instead of firing unsupervised.
kind: how-to
audience: user
slug: set-up-approval-gates
time: 10 min
updated: 2026-05-22
---

Some tool calls write files, run shell commands, or hit the network. You do not want them firing unsupervised. Approval gates make the agent pause and ask before the dangerous call runs — or refuse it outright.

## Task

Configure a [personality](../../getting-started/glossary.md#personality)'s `safety.approvalMode` so the agent pauses (or doesn't) before a dangerous tool call.

## Result

The chosen personality routes every `dangerous` classification through the chosen mode — modal prompt, smart-classifier auto-approval, or auto-fire — while the `blocked` hardline floor continues to refuse the worst commands no matter what.

## Prereqs

- A personality you own at `~/.ethos/personalities/<id>/` (built-ins shadow safely — copy with `ethos personality duplicate <built-in> <id>` if you want to override).
- Familiarity with the [personality config reference](../reference/personality-yaml.md).

## 1. Pick the right mode for the surface

Ethos's safety classifier sorts every tool call into one of three buckets. `safe` calls auto-fire. `blocked` calls are refused unconditionally — they are the hardline floor in [extensions/tools-terminal/src/guard.ts](https://github.com/ethosagent/ethos/blob/main/extensions/tools-terminal/src/guard.ts) (recursive `rm -rf /` or `~`, `dd of=/dev/sdX`, `mkfs`, `chmod` with setuid, writes to `/etc/sudoers` or `~/.ssh/authorized_keys`, `DROP TABLE`, fork bombs, etc.). `dangerous` calls are the middle band — destructive enough to want a human in the loop, not so destructive that they should never run.

`safety.approvalMode` decides what happens to that middle band.

| Mode | What happens on `dangerous` | When to pick it |
|---|---|---|
| `manual` *(default)* | Surface an approval prompt; wait for Allow / Deny. | Personal CLI sessions. Web UI personalities. Any time you are sitting at the terminal and can answer in seconds. |
| `smart` | A fast auxiliary model reviews the call. Low residual risk → auto-approve. Anything else → fall back to `manual`. | Long-running agent sessions where approval fatigue is the failure mode. Trades latency and a small token bill for fewer interruptions. |
| `off` | Auto-fire. `blocked` calls still refuse. | Trusted local automation only — cron, batch runs, headless test rigs. Refused at config load when combined with any channel ingress. |

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

## 3. Reload the personality

Personalities are mtime-cached. Save `config.yaml` and the next turn picks up the new mode — no restart, no `/new`. Confirm with:

```
ethos personality show <id>
```

The generated character sheet prints the safety section verbatim.

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

### CLI (`ethos chat`)

The CLI does not have an interactive approval flow. `dangerous` terminal commands that hit the hardline blocklist surface as a tool error in the transcript:

```
Command blocked: recursive force-delete of root or home directory.
This operation requires explicit human approval before proceeding.
```

The agent gets the error back as a tool result and continues the turn — usually by trying a less destructive approach or asking you what to do. `manual` mode on the CLI today only affects the hardline floor; non-hardline `dangerous` calls auto-fire because the CLI has no modal to surface. If you need interactive approval, run `ethos serve` and use the web UI.

### Web UI (`ethos serve`)

The web UI ships the full flow. A `dangerous` call posts an approval card anchored to the personality bar (`apps/web/src/components/chat/ApprovalModal.tsx`) with the tool name, reason, and a JSON-formatted args preview. You pick one of three scopes:

- **Just this command** — allow this single invocation, ask again next time.
- **This exact command** — allow this tool with these exact arguments forever.
- **Any args for this tool** — allow every future invocation of this tool.

Allow or Deny resolves the suspended `before_tool_call` hook. The card updates in place to show the outcome. Hardline `blocked` calls never reach the modal — they error out before the prompt.

### Slack and Telegram

Both adapters implement `ApprovalCapableAdapter` and post an interactive approval card with Allow / Deny buttons in the originating conversation (DM or channel). The flow is wired in [apps/ethos/src/commands/gateway.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts) and binds the approval to the user whose message triggered the turn — a bystander in the channel cannot click Allow on a tool call they did not request. The card updates in place to show who decided what.

Threads work on Slack (the card posts in the same thread as the inbound message). On Telegram the card posts as a reply to the triggering message.

### Discord and email

Neither adapter implements `ApprovalCapableAdapter` yet. A `dangerous` call from a Discord or email-driven turn fails closed — the approval coordinator denies it because there is no surface to render the prompt. Use Slack or Telegram if you need channel-driven approvals.

## Verify

- `ethos personality show <id>` — the printed character sheet includes `safety.approvalMode: <mode>`.
- Save `approvalMode: off` on a personality with `platform: telegram` — the next personality load throws the rejection above.
- Save `approvalMode: invalid` — the next load throws `Invalid approvalMode: "invalid". Expected one of: manual, smart, off`.
- In the web UI, ask the personality to run a hardline-matching command (e.g. `rm -rf ~/.ssh`) — the call surfaces as a tool error, not as an approval card, confirming the hardline floor is upstream of the modal.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid approvalMode: "X". Expected one of: manual, smart, off` | A typo in `config.yaml` — only the three literal values are accepted. | Pick `manual`, `smart`, or `off`. |
| `personality "X" has approvalMode: off but is bound to channel "telegram"` | `off` on a personality with `platform: telegram \| discord \| slack \| whatsapp \| email`. | Move to `smart` or `manual`, or remove the `platform` binding so the personality is CLI/cron only. |
| `dangerous` calls in CLI fire without prompting | The CLI does not render approval modals. Only the hardline `blocked` floor blocks; the rest auto-fire. | Run via `ethos serve` for the interactive flow, or switch the surface to Slack / Telegram. |
| Slack / Telegram card never appears for a `dangerous` call | The adapter is wired but the personality is not bound to that bot, or the `dangerous` classification did not fire (no `alwaysAsk` tools and no hardline match). | Confirm the bot binding in `~/.ethos/config.yaml`. The current `dangerous` band fires for terminal hardlines and for tools the deployment explicitly marks `alwaysAsk` — there is no user-facing knob for the latter yet. |
| `smart` mode behaves like `manual` | The smart-approve callback is not wired in this build. | `smart` degrades to `manual` when no fast classifier is configured. This is the documented fallback. |

## Caveats

**Teams.** Each personality on a team applies its own `safety.approvalMode` independently. A `manual` engineer and an `off` (cron-only) batch member can coexist on the same board — the gate runs per `before_tool_call`, scoped to the loop that owns the turn. There is no team-level approval setting; the personality is the unit.

**Long-running tools.** Approval suspends the `before_tool_call` hook. The turn sits idle until you decide. There is no timeout on the prompt today — if you walk away from the web UI mid-turn, the suspended hook waits indefinitely. Close the session (`/new`) to release it.

**`approvalMode: off` is documentation-only today.** The danger predicate gates `off` behind an internal `allowAutoApproveDangerousTools` capability flag that no production caller currently sets — see the contract in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts). Practically: `off` and `manual` produce the same runtime behaviour right now (everything except the hardline floor auto-fires). Configuring `off` is still meaningful because it records intent and is the load-time signal that rejects the unsafe channel combination. When the cron / batch runner grows an approval surface, `off` will start auto-approving as documented.

**Async approval on channels.** Slack and Telegram approvals are not time-bounded either. A button left unclicked holds the turn open until the session ends. For DMs that means one user one decision; for channels it means whoever triggered the turn is the only one whose click counts.

## See also

- [Personality config reference](../reference/personality-yaml.md) — every field on `safety:` and the rest of `config.yaml`.
- [What are the built-in personalities, and why these three?](../explanation/built-in-personalities.md) — how the built-ins handle approval modes by default.
- [Security overview](../../security/overview.md) — where approval gates sit in the trust model.
- [Slash commands reference](../reference/slash-commands.md) — `/personality` to switch the active role mid-conversation.
