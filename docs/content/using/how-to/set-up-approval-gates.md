---
title: Set up approval gates for dangerous tool calls
description: Configure the safety.approvalMode knob so dangerous tool calls pause for human review instead of firing unsupervised.
kind: how-to
audience: user
slug: set-up-approval-gates
time: 10 min
updated: 2026-11-03
---

Some tool calls write files, run shell commands, or hit the network. You do not want them firing unsupervised. Approval gates make the agent pause and ask before the dangerous call runs — or refuse it outright.

## Task

Configure a [personality](../../getting-started/glossary.md#personality)'s `safety.approvalMode` so the agent pauses (or doesn't) before a dangerous tool call.

## Result

The chosen personality routes every `dangerous` classification through the chosen mode — modal prompt, reviewer-judged auto-approval, or auto-fire — while the `blocked` hardline floor continues to refuse the worst commands no matter what.

## Prereqs

- A personality you own at `~/.ethos/personalities/<id>/` (built-ins shadow safely — copy with `ethos personality duplicate <built-in> <id>` if you want to override).
- Familiarity with the [personality config reference](../reference/personality-yaml.md).

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-4: pick the mode, add the YAML, reload, the refused combination |
| [Approval surfaces](set-up-approval-gates/approval-surfaces.md) | Step 5: what the prompt looks like in the CLI, web UI, chat bots and unattended runs |

## 1. Pick the right mode for the surface

Ethos's safety classifier sorts every tool call into one of three buckets. `safe` calls auto-fire. `blocked` calls are refused unconditionally — they are the hardline floor in [extensions/tools-terminal/src/guard.ts](https://github.com/ethosagent/ethos/blob/main/extensions/tools-terminal/src/guard.ts) (recursive `rm -rf /` or `~`, `dd of=/dev/sdX`, `mkfs`, `chmod` with setuid, writes to `/etc/sudoers` or `~/.ssh/authorized_keys`, `DROP TABLE`, fork bombs, etc.). `dangerous` calls are the middle band — destructive enough to want a human in the loop, not so destructive that they should never run.

`safety.approvalMode` decides what happens to that middle band.

| Mode | What happens on `dangerous` | When to pick it |
|---|---|---|
| `manual` *(default)* | Surface an approval prompt; wait for Allow / Deny. | Web UI, `ethos chat` (readline prompt or TUI modal), and Slack / Telegram / Discord bots. Any time you can answer a prompt in seconds. Where nobody can answer — `ethos chat -q`, piped stdin, `ethos -z`, `batch`, `eval`, `cron`, `bench`, `ethos mcp serve`, ACP — the call is refused instead (see step 5). |
| `smart` | An LLM reviewer judges the call first. `approve` → runs with no prompt. `deny` and `ask` → the approval prompt still fires, carrying the reviewer's reason. | Long-running agent sessions where approval fatigue is the failure mode. Trades latency and reviewer tokens for fewer interruptions. |
| `off` | Auto-fire. `blocked` calls still refuse. | Trusted local automation only — cron, batch runs, headless test rigs. Refused at config load when combined with any channel ingress. On the gateway's cron/dream loop it takes effect only when the operator also sets `allowUnattendedDangerousTools: true` in `config.yaml`; otherwise flagged calls there are refused, because nobody is present to approve them. Even with that key, a command using `$(…)` or backticks is refused there. On `ethos cron run` and `ethos cron daemon` the same opt-in applies. In `ethos chat` and the other CLI commands (`-z`, `batch`, `eval`, `bench`, `mcp serve`, `acp`) it takes effect as is, except that a command using `$(…)` or backticks is still asked about (or refused where nobody can be asked). It never takes effect in the web UI or on any chat bot: there `off` behaves like `manual`. |

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

Step 5, what approval looks like on each surface, continues in [approval surfaces](set-up-approval-gates/approval-surfaces.md).

## Verify

- `ethos personality show <id> --json | jq .config.safety` — prints `{"approvalMode": "<mode>"}`.
- Save `approvalMode: off` on a personality with `platform: telegram` — the next personality load throws the rejection above.
- Save `approvalMode: invalid` — the next load throws `Invalid approvalMode: "invalid". Expected one of: manual, smart, off`.
- On `approvalMode: smart`, ask the personality to write a file in the web UI. Either no card appears (the reviewer approved) or the card's reason reads `denied by reviewer: <one sentence>` — both confirm the reviewer ran.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid approvalMode: "X". Expected one of: manual, smart, off` | A typo in `config.yaml` — only the three literal values are accepted. | Pick `manual`, `smart`, or `off`. |
| `personality "X" has approvalMode: off but is bound to channel "telegram"` | `off` on a personality with `platform: telegram \| discord \| slack \| whatsapp \| email`. | Move to `smart` or `manual`, or remove the `platform` binding so the personality is CLI/cron only. |
| `dangerous` calls in `ethos chat` fire without prompting | The personality is on `approvalMode: off`, or the call is not flagged: on a docker posture `terminal` is flagged only under `smart` or when its command uses `$(…)` or backticks. | Check the mode with `ethos personality show <id> --json`. |
| `smart` mode prompts for everything anyway | The reviewer is failing closed — provider error, a round-trip over 15s, or a response that wasn't the expected JSON. Every one resolves to `ask`. | Check that the `model` and provider credentials in `~/.ethos/config.yaml` work; the reviewer runs on the primary model, so a broken primary breaks the reviewer. |

## Caveats

**Teams.** Each personality on a team applies its own `safety.approvalMode` independently. A `manual` engineer and an `off` (cron-only) batch member can coexist on the same board — the gate runs per `before_tool_call`, scoped to the loop that owns the turn. There is no team-level approval setting; the personality is the unit.

**`approvalMode: off` auto-approves in two places only.** The danger predicate honours `off` only behind its `allowAutoApproveDangerousTools` capability (see the contract in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts)). Two callers pass it. The unattended cron gate, `wireUnattendedApprovalGate` in [apps/ethos/src/unattended-approval-gate.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/unattended-approval-gate.ts) — on the gateway's cron/dream loop and on `ethos cron run` / `ethos cron daemon` — passes it only when `allowUnattendedDangerousTools: true` is set in `config.yaml`. The terminal gate, `wireTerminalApprovalGate` in [apps/ethos/src/terminal-approval.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/terminal-approval.ts), always passes it, because `ethos chat` and the other operator-invoked CLI commands run on your own machine. Everywhere else `off` behaves exactly like `manual`. Configuring `off` still records intent, and it is the load-time signal that rejects the unsafe channel combination.

**Reviewer spend is not billed to the turn.** Smart-mode reviews consume tokens, and none of it lands in the turn's cost accounting or in `estimatedCostUsd` on the `usage` event. There is no path from a `before_tool_call` hook into `sessionCosts` — closing it means a contract change under `packages/types/`. The kanban completion verifier and the eval-harness scorers discard usage the same way. Volume is bounded rather than measured: the reviewer fires only for calls that already reached the danger band, and repeats are served from the verdict cache. Attribution is a follow-up.

**The reviewer runs on your primary model.** There is no `auxiliary.approvals` config block yet, so `smart` reviews cost primary-model tokens and primary-model latency — not the cheap-model bill the mode's name suggests. Budget for it before turning `smart` on with an expensive `model:` in `~/.ethos/config.yaml`.

**Three denials in a row stop the turn.** After three consecutive `before_tool_call` denials the loop emits a `halt` event (`Stopped: 3 tool calls denied in a row — retrying will not help`) and stops, on the theory that an agent that has been refused three times will not guess its way to an approval. The count is hard-coded — there is no config knob. Only approval denials advance it; a batch in which some tool actually ran restarts the count at that batch's denials instead of adding to the streak.

## See also

- [Personality config reference](../reference/personality-yaml.md) — every field on `safety:` and the rest of `config.yaml`.
- [What are the built-in personalities, and why these three?](../explanation/built-in-personalities.md) — how the built-ins handle approval modes by default.
- [Security overview](../../security/overview.md) — where approval gates sit in the trust model.
- [Slash commands reference](../reference/slash-commands.md) — `/personality` to switch the active role mid-conversation.
