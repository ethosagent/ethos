---
title: Initiative budget and delivery
description: How the initiative engine splits a day's budget across windows, what each cap enforces, and how the morning digest and channel taps reach the owner.
kind: reference
audience: user
slug: initiatives-budget-and-delivery
updated: 2026-11-28
---

The engine decides how many windows to run from the day's budget, caps each window by what is left, and reports to one owner channel. This page gives the formulas and the delivery rules as the code applies them.

## Source {#source}

| Part | File |
|---|---|
| Day plan and window guard | [`extensions/initiative-runner/src/budget.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/initiative-runner/src/budget.ts) (`planDay`, `createWindowGuard`) |
| Caps per run | [`extensions/initiative-runner/src/runner.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/initiative-runner/src/runner.ts) |
| Schedule and digest send | [`packages/wiring/src/initiative-runtime.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/initiative-runtime.ts) |
| Taps and digest sender | [`apps/ethos/src/lib/initiative-wiring.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/initiative-wiring.ts) |

Tests: `budget.test.ts`, `day-caps.test.ts`, `initiative-tick.test.ts`, `initiative-digest.test.ts`, `initiative-wiring.test.ts`.

## Budget formula {#budget-formula}

The `initiative-tick` system job runs every 5 minutes. For each enabled initiative with open explorations (`exploring` or `stalled`) and at least one window today, it calls `planDay` once per tick:

| Quantity | Value |
|---|---|
| Brief reserve | `usd_per_day` x 0.15 (`BRIEF_RESERVE_SHARE`) |
| Scan reserve | $0.25 (`SCAN_CAP_USD`) when the personality's `selfStart` is on, otherwise $0 |
| Pool | `usd_per_day` minus both reserves, floored at $0 |
| Funded windows | `floor(pool / 0.05)`, where $0.05 is `PER_CALL_RESERVE_USD` |
| Windows that run | the smaller of the schedule's slots today and the funded windows; none when nothing is open |
| Per-window share | pool divided by the windows that run; it becomes each window's cap |
| Skipped | open explorations that get no window |

Slots go to open explorations in rotation: the one that ran longest ago first, never-run first, wrapping round, so one open exploration takes every funded slot. A slot whose start time passed while the process was down is skipped and not replayed.

Example: `usd_per_day: 3`, three open explorations, two windows today, `selfStart` off. The brief reserve is $0.45 and the pool $2.55. Two windows run at a $1.275 share each, and one exploration is skipped today. With `selfStart` on the scan reserve takes $0.25 and the pool is $2.30, a $1.15 share.

### What actually caps a window {#window-caps}

The tick passes the per-window share to the run as its own cap, and the run holds the brief reserve back from the day. `createWindowGuard` stops a window when any remaining amount drops below $0.05:

| Cap | Remaining amount | Ends as |
|---|---|---|
| Day | the smallest of `usd_per_day` minus today's spend, the self-start pool left (agent origin) and the operator totals left, less the brief reserve (`usd_per_day` x 0.15) for an exploration window | `day` |
| Window | the per-window share from `planDay` (`windowCapUsd`); a run started by hand has none | `window` |
| Exploration | exploration budget minus its spend. A brief window gets `usd_per_day` x 0.15. A survey gets $1 (`SURVEY_CAP_USD`) and a scan $0.25. | `exploration` |

When more than one is out, `day` wins over `window`, and `window` over `exploration`. A brief window and a survey or scan do not hold the reserve back, so a stalled exploration can still hand in its partial brief after exploration windows have used up the rest of the day. The in-flight call still finishes, so a window overshoots by at most one call. An invalid or negative cost ends the window as a day stop (`budget.test.ts`, "invalid cost"). The window cap and the reserve are pinned by `budget.test.ts` and `window-budget.test.ts`.

### Cross-process reservation {#reservation}

A run reads what is left of the day before it starts, but its spend only lands when its window closes. So the window is opened with a reservation: `reserveAndOpenWindow` inserts a row in the `window_reservations` table of `initiatives.db` and the window row in one `BEGIN IMMEDIATE` transaction. It refuses when, for any of the initiative, personality, total and agent-pool ceilings, and, for an exploring window, the exploration's own budget (its `budget_usd` minus its recorded spend minus its other live reservations; a survey, scan or brief window holds none), the cap minus the day's spend minus other live reservations is below what this window may spend. The reservation is the smallest of the day left (less the brief reserve), the window's own cap and its exploration's remaining budget. `closeWindow` deletes the row in the transaction that records the spend. A reservation expires two hours (`RESERVATION_TTL_MS`) after its last heartbeat and is then ignored, so a crashed process cannot block the day. A running window renews the hold (`touchReservation`) on every model usage event and paid-tool charge, so a long window keeps it and a second process stays refused (`window-budget.test.ts`, "the reservation heartbeat").

This is what keeps `ethos initiatives run` and `ethos serve` from spending the same dollars. A run refused this way throws and opens no window; try again when the other run has finished. Pinned by `extensions/initiative-store/src/__tests__/reservations.test.ts`.

The original design page assumed a flat $0.35 per window with a $0.40 scan reserve. The code does not do that.

### Paid tool calls {#tool-prices}

Model `usage` is metered as it arrives. A paid tool's provider bill never reaches the run, so each call is charged a fixed estimate (`INITIATIVE_TOOL_CALL_USD`, `tool-prices.ts`) before it runs. The L4 tool gate (`tool-gate.ts`) passes the price to `createWindowGuard`'s `chargeToolCall`. If the charge would leave any cap (day, window or exploration) below $0.05, the call is refused, nothing is charged, and the window ends as that cap. The charge lands in the window's `spent_usd` like model cost.

| Tool | USD per call | Basis |
|---|---|---|
| `web_search`, `linkedin_search`, `reddit_web_search`, `quora_search` | 0.01 | Exa ~$0.005, Tavily ~$0.008, Brave ~$0.005 per query, rounded up. The site searches use the same backend. |
| `web_extract` | 0.002 | Estimate from Exa contents at ~$0.001 a page. |
| `engine_ask` | 0.10 | Estimate: model tokens plus a search fee, roughly $0.005 to $0.05. |
| `x_search` | 0.10 | Estimate: X API pay-per-use, ~$0.005 a post, for a 20-post page. |

Every other read tool is free (`INITIATIVE_FREE_READ_TOOLS`): local files, memory and session reads, Kanban and goals, Reddit and YouTube. `tool-prices.test.ts` fails when a read tool is in neither list. The repo holds no provider price, so these figures are estimates, not measured bills; `window-budget.test.ts` pins the charge and the refusal.

## Morning digest {#digest}

Once per day in your notification time zone, at or after the personality's `delivery.digestTime`, the tick composes a digest (`composeDigest`) and sends it to `delivery.ownerChannel`. It lists what the engine did on its own, proposals needing a Gate 1 yes, agent-started initiatives, briefs ready for Gate 2, open questions and agent suggestions. An empty digest is not sent.

| Rule | Detail |
|---|---|
| Recipient | `<platform>:<chatId>` from `settings.yaml`. Nothing a model wrote picks it. |
| Format | Markdown (`renderDigestMarkdown`), with each item's `ethos initiatives` command. On Slack and Telegram the same digest also goes out as a button card (`digestBlocks`, `digestCard`). The Markdown is the ledger's content and the fallback. |
| Transport | `Gateway.notifyTrackedOutcome`: it rides the delivery ledger and holds the notice for quiet hours. A card-capable adapter (`sendInitiativeDigest`) renders the buttons inside that one tracked send; any other adapter gets the Markdown. |
| Time zone | `delivery.digestTime` is read in `notifications.timezone`, the zone quiet hours use, and otherwise in the zone of the machine running Ethos. The day is that zone's calendar day, so a digest due at 08:00 in `Asia/Kolkata` goes out from 02:30 UTC and follows DST changes. Pinned by `packages/wiring/src/__tests__/initiative-digest.test.ts`. Windows and day budgets still count UTC days. |
| Duplicates | `.digest-sent.json` under the personality's `initiatives/` folder records the local day, written before the hand-off. A send that wrote nothing durable (no bot, no ledger, or the ledger write failed) restores the marker so the next tick retries. A send the platform did not confirm but the delivery ledger holds as `pending` keeps the marker: the gateway sweep re-sends the text, and the runtime only reports it. Pinned by `packages/wiring/src/__tests__/initiative-digest.test.ts`. |
| Several bots | If more than one bot serves the owner's platform, the send is refused (`createDigestNotify` returns `false`) rather than going out as the wrong bot. |

On Slack, a card Slack refuses by shape (`invalid_blocks`, `msg_too_long`, `invalid_arguments`) falls back to the Markdown text once, in the same call; a transient error does not. Telegram sends one card for the digest, or the digest without its briefs plus one `briefCard` each when it is over 4096 characters. If a card cannot be built or carries no button, the Markdown text goes out instead. A notice held for quiet hours, and a ledger redelivery, carry only the Markdown: they arrive without buttons. Pinned by `extensions/gateway/src/__tests__/initiative-digest-delivery.test.ts`, `extensions/platform-telegram/src/__tests__/initiative-digest-send.test.ts` and `extensions/platform-slack/src/__tests__/initiative-digest-send.test.ts`. The buttons are answered by the tap handler below.

## Channel taps {#taps}

A tap on an initiative button (approve, reject, snooze, adopt, dig deeper, park, keep, stop) goes to `createInitiativeTapHandler`.

| Rule | Detail |
|---|---|
| Who may tap | Only the user id equal to `channel_filter.<platform>.ownerUserId`. Anyone else gets "Only the owner can decide this." and nothing is written (`initiative-wiring.test.ts`, "non-owner tap refused"). |
| What it does | Calls `decideInitiative` as `owner:<platform>:<userId>`, the same function the CLI and web app use. |
| Adopt | Takes the option the latest brief recommends. |
| Make it mine | Writes nothing. The tap answers that you confirm the rewrite in chat. |
| The message | The original message and its buttons stay as they were. |

## See also {#see-also}

- [Initiative config reference](./initiatives-config.md) — `usd_per_day`, `delivery.*` and the operator ceilings.
- [Why is the initiative engine read-only, and what does it cost?](../explanation/initiatives.md) — the limits that apply to spend and delivery.
- [CLI: ethos initiatives](./cli/initiatives.md) — decide from a shell when a tap is not available.
