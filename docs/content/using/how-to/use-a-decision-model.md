---
title: Use a decision model
description: Add TypeSafe's Jev as a decision model, enable its injection, approver and router sites per personality, and read its decisions in chat.
kind: how-to
audience: user
slug: use-a-decision-model
time: 15 min
updated: 2026-09-25
---

Some of the checks an agent runs are yes-or-no questions: is this tool result trying to instruct the agent, should this risky call run, does this message need the big model? A decision model answers those questions directly, with a probability, in tens of milliseconds, instead of asking an LLM to write a paragraph that Ethos then parses. The chat shows every answer, with how long it took.

## Task

Add a decision model (TypeSafe's Jev) on this machine, then turn it on for one [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory and model) at the sites you choose.

## Result

That personality asks Jev at each enabled site. In `shadow`, today's check still decides and Jev's answer is recorded beside it. In `on`, Jev's answer decides whenever it is confident enough. Every other personality behaves exactly as before, and the chat's trail shows each decision with its duration.

## Prereqs

- Ethos running with the web UI (`ethos serve`), or the CLI for the config-file route.
- A TypeSafe API key. Sign up at `console.typesafe.ai` and create a key in the console.
- A personality you own at `~/.ethos/personalities/<id>/`. Built-ins ship with no `decisions` block; copy one with `ethos personality duplicate <built-in> <id>` if you want to start from it.

## 1. Add Jev to this machine

The operator half lives in `~/.ethos/config.yaml`: which provider, its key, its endpoint and its measured thresholds. A personality can only use a decision model this machine has.

1. Open **Settings → Models & providers**, then the **decision models** section.
2. Click **Add decision model**, pick **Jev** (by TypeSafe), paste the key and click **Add decision model**.
3. Type a message into the **test** box and click **Test**.

A working key shows every field of the answer. An excerpt:

```
contains instructions   ✓ no
p                       0.031
confidence              0.938
model                   jev-1.13.0
latency                 212 ms
redaction               Nothing to redact; sent as typed.
```

The row reads `✓ key stored` and `active`, and **Used by** reads "No personality uses this decision model yet". Adding the model writes `decisions.provider: typesafe` to `~/.ethos/config.yaml` and stores the key at vault ref `providers/typesafe/apiKey`.

If you prefer the CLI, run the same two steps by hand:

```sh
ethos secrets set providers/typesafe/apiKey <your-api-key>
```

Then add this line to `~/.ethos/config.yaml`:

```yaml
decisions.provider: typesafe
```

Nothing is sent to TypeSafe yet. Adding the model enables no site.

## 2. Enable sites on one personality

1. Open **Personalities**, pick the personality, click **Edit** and open the **Config** tab.
2. Under **Model**, set **Decision model** to `Jev · TypeSafe`.
3. Set each site to `off`, `shadow` or `on`:

| Row | Site | What it asks | When it does not decide |
|---|---|---|---|
| Injection check | `injection` | Is this tool result trying to instruct the agent? | The LLM check runs, as today. |
| Tool approvals | `approver` | Should this flagged tool call run, be refused, or wait for you? | The LLM review runs, as today. Only consulted when **Approval mode** is Smart ([approval gates](set-up-approval-gates.md)). |
| Model routing | `router` | Does this message need only the trivial model? It never routes up. | The turn runs on the default model, as today. |

4. Click **Save**.

The same choice as lines in `~/.ethos/personalities/<id>/config.yaml` (flat `key: value`, like every personality key):

```yaml
decisions.provider: typesafe
decisions.sites.injection: shadow
decisions.sites.approver: off
decisions.sites.router: shadow
```

An unset site is `off`. A site value other than `off`, `shadow` or `on` is dropped at load. The file is re-read before the next turn, so no restart is needed.

## 3. Start in shadow, switch to on with measured thresholds

| Mode | Who decides | What it costs the turn |
|---|---|---|
| `off` (default) | Today's check. Jev is not asked. | Nothing. |
| `shadow` | Today's check. Jev is asked at the same time and its answer is recorded, with any disagreement. | No added latency: Ethos never waits for Jev in shadow. |
| `on` | Jev, when its confidence is at or above the site's threshold. Below it, or on any failure, today's check decides. | Jev's latency, instead of the LLM check's. |

Run a site in `shadow` first. The disagreement count in the chat and the rows in `observability.db` are the evidence for switching.

`on` needs a threshold for that site in `~/.ethos/config.yaml`:

```yaml
decisions.thresholds.injection: 0.8
decisions.thresholds.approver.approve: 0.9
decisions.thresholds.approver.deny: 0.8
decisions.thresholds.router: 0.85
```

Each value is a confidence in `[0, 1]`. Do not guess it. Measure it with the calibration harness, `runDecisionCalibration` in [extensions/eval-harness/src/decision-calibration.ts](https://github.com/ethosagent/ethos/blob/main/extensions/eval-harness/src/decision-calibration.ts), which runs a labelled set through Jev and returns the smallest confidence at which acting on Jev's verdict is precise enough. It is a library function, not a CLI command.

If a site is set to `on` and its threshold is missing, the site runs `shadow` and says so everywhere: the Config tab, `ethos doctor` and `ethos personality show`. It never stops Ethos from starting.

To keep a vendor alias from moving under a measured threshold, pin the model in `~/.ethos/config.yaml`: `decisions.model: jev-1.13.0`.

## 4. Read decisions in chat

Web, desktop and CLI chat show every decision the turn's personality enabled. Channel adapters (Telegram, Slack, Discord, WhatsApp, email) show none.

**The trail footer** under the reply counts decisions apart from actions, with their total time:

```
✓ 1 action · 2 decisions 1.3s · 5ms ▸
✓ 1 action · 1 decision observed 13 ms · ⚠ 1 disagreement · 4ms ▸
```

A turn with both modes reads `2 decisions 80 ms · 1 observed 38 ms`.

**Expanded rows** sit in event order beside the tool rows: the router first, the approver before its tool, the injection check after it. Each row is a glyph and a word, the `jev` tag, `site · verdict · conf N`, a detail line with the returned model, and the duration on the right:

| Row | Mode | Meaning |
|---|---|---|
| `✓ decided` | `on` | Jev was confident enough, and its answer decided. |
| `⚠ unsure → LLM check` | `on` | Jev answered below the threshold, so today's check decided. The approver reads `→ LLM review` and the router `→ default model`. |
| `✓ observed` | `shadow` | Jev agreed with today's check, which decided. Shows `36 ms vs 1.4s` when both were timed. |
| `⚠ observed` | `shadow` | Jev disagreed. The detail line names what today's check said, for example `LLM check said clean`. |
| `✗ unavailable` | either | The call failed (timeout, network, error). In `on`, today's check decided. |
| `✗ skipped` | either | No request was sent: the decision model is paused after repeated failures. |

**The status line** above the composer shows `jev checking read_file result` while an `on` decision holds the turn. Shadow never holds the turn, so it never shows there.

**CLI chat** prints one line per decision, hidden at `quiet` verbosity:

```
  ✓ decided jev router · trivial 0.95 · 46 ms
  ⚠ observed jev injection · flagged · LLM said clean · 63 ms vs 24 ms
```

Rows are saved with the session, so a reloaded chat shows the same trail.

## What leaves this machine

Nothing is sent to TypeSafe unless a personality sets a site to `shadow` or `on` and this machine has `decisions.provider` and a key. With no key, every site runs today's path.

What is sent is a digest, redacted by `@ethosagent/safety-redact` first: the tool result text (injection), the tool name, arguments and danger reason (approver), or the user's message (router). The **Test** result in Settings shows the exact redacted text it sent.

## Verify

Run `ethos doctor`. Its Config section names the decision model and every personality that declares one:

```
     decisions:   typesafe → api.typesafe.ai · model jev-latest
                  researcher: injection shadow · router shadow
                  sentinel:   injection on · router on
```

A site running below what it asked for says why: ``injection `on` requested, running `shadow`: `decisions.thresholds.injection` missing``.

Run `ethos personality show <id>`. The character sheet gains a `## Decisions` section:

```
## Decisions
- Decision model: typesafe → api.typesafe.ai · model jev-latest
- injection: on
- approver: off
- router: on
```

In **Settings → Models & providers → decision models**, **Used by** lists the personality with its sites. Then send a message that makes the personality read a file: the trail footer shows the decision count.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `⚠ decisions: <id> names decision model "typesafe", but ~/.ethos/config.yaml has no decisions.provider` | The personality asks for a model this machine has not added. Every site runs `off`. | Add the model in Settings (step 1). |
| `⚠ decisions: <id> enables injection but names no decisions.provider` | The personality sets sites but picks no decision model. Its sites run `off`. | Add `decisions.provider: typesafe` to its `config.yaml`, or pick the model in the Config tab. |
| `⚠ decisions: no key at vault ref providers/typesafe/apiKey` | The provider is set but the key is missing. Every site runs today's path. | `ethos secrets set providers/typesafe/apiKey <your-api-key>` |
| `decisions.sites.injection: shadow is no longer read` | A site line sits in `~/.ethos/config.yaml`. Sites are enabled per personality. | Move it to the personality's `config.yaml` with `decisions.provider: typesafe`. |
| `⚠ decisions: <id> enables the approver site, but approvalMode is manual` | The approver is consulted only under Smart approval. | Set `safety.approvalMode: smart`, or turn the site off. |
| No decision rows in chat | The site is `off`, or the router's two tiers resolve to the same model, so it made no call. | Check `ethos personality show <id>`. |
| Rows read `✗ skipped` | The provider failed repeatedly and is paused. | Check the key and endpoint with **Test**. |

## See also

- [Set up approval gates](set-up-approval-gates.md), for the Smart approval mode the approver site needs.
- [Personality config reference](../reference/personality-yaml.md), for the rest of a personality's `config.yaml`.
- [Configure providers](configure-providers.md), for the chat models the decision model sits beside.
- [Why is a decision provider a new contract type?](../../building/explanation/decision-provider-governance.md), for why the provider is global and the enablement is per personality.
