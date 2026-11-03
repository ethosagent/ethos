---
title: "Use a decision model: read decisions and ask Jev"
description: "Read a decision model's answers in the chat trail and put a question to Jev directly with the decide tool."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Read the decisions Jev makes in chat, then put a question to Jev yourself with the `decide` tool.

## Result

The chat trail shows each decision with its mode, verdict and duration, and `decide` returns Jev's probability for a question you ask.

## Prereqs

- Complete [steps 1-3](../use-a-decision-model.md): Jev added and at least one site set to `shadow` or `on` on a personality.

## Steps

## 4. Read decisions in chat

Web, desktop and CLI chat show every decision the turn's personality enabled. Channel adapters (Telegram, Slack, Discord, WhatsApp, email) show none.

**The trail footer** above the reply counts decisions apart from actions, with their total time:

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

## 5. Ask Jev directly

Choosing a decision model also gives the personality a `decide` tool, so you can put a question to Jev yourself. Nothing else to enable: no `toolset.yaml` line and no site. The tool appears when the personality's `decisions.provider` matches the one in `~/.ethos/config.yaml`, and every other personality never sees it.

Confirm it with `ethos personality show <id>`. The `## Decisions` section carries the line:

```
- tool: decide (via decision model)
```

Then ask in chat:

```
Ask Jev: is RELIANCE a buy on this setup? state: price 2,940 above 50-DMA, RSI 61, volume 1.4x 20-day average, broke 2,900 resistance yesterday.
```

The agent calls `decide` with the state and typed questions (`boolean`, `choice` or `score`, each with criteria). The trail shows an ordinary `decide` action row whose result is one line per question plus the model:

```
buy: yes p=0.82 conf=0.71
model=jev-1.13.0 latency=412ms calibrated=true
```

The reply quotes Jev's probability rather than inventing one.

If the call fails, the row is an error that starts `Jev failed (<code>):`, for example `Jev failed (timeout)` or `Jev failed (no_key)`, and the agent tells you Jev did not answer instead of answering in Jev's place. A request with more than 8 questions or more than 24,000 characters of state is refused before anything is sent.

Every call is recorded in `observability.db` under the `decision.tool` category, apart from the sites' `decision.call` rows so it never skews their calibration:

```sh
sqlite3 ~/.ethos/observability.db "select code, details from events where category='decision.tool' order by ts desc limit 1"
```

```
ok|{"provider":"typesafe","model":"jev-1.13.0","latencyMs":412,"inputTokens":180,"questionCount":1,...}
```

The tool uses the same key, redaction and pause-after-failures as the sites: when repeated failures pause the sites, the tool answers `Jev failed (breaker_open)` too.

## Verify

Run `ethos personality show <id>` — the `## Decisions` section lists `- tool: decide (via decision model)`. Send a message that makes the personality read a file in web or CLI chat: the trail footer shows a decision count such as `1 decision`.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| No decision rows in chat | The site is `off`, or the router's two tiers resolve to the same model, so it made no call. | Check `ethos personality show <id>`. |
| Rows read `✗ skipped` | The provider failed repeatedly and is paused. | Check the key and endpoint with **Test**. |

## See also

- [Use a decision model](../use-a-decision-model.md) — steps 1-3 and the rest of the troubleshooting table.
- [Personality config reference](../../reference/personality-yaml.md), for the rest of a personality's `config.yaml`.
