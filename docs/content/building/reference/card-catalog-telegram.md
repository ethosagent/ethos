---
title: Cards on Telegram
description: "How the eight emit_card kinds render as Telegram messages, when the gateway posts them, and what a recommend_actions button tap does."
kind: reference
audience: developer
slug: card-catalog-telegram
updated: 2026-11-28
---

Telegram draws every [card](./card-catalog.md) kind except `canvas` as an HTML message. This page is the mapping from each kind to its Telegram form, plus the posting and button rules. Payload fields and caps live in the [card catalog](./card-catalog.md).

## Source {#source}

[`extensions/platform-telegram/src/cards/render.ts`](https://github.com/ethosagent/ethos/tree/main/extensions/platform-telegram/src/cards/render.ts) renders. [`extensions/gateway/src/card-post.ts`](https://github.com/ethosagent/ethos/tree/main/extensions/gateway/src/card-post.ts) posts. [`extensions/platform-telegram/src/store/card-actions.ts`](https://github.com/ethosagent/ethos/tree/main/extensions/platform-telegram/src/store/card-actions.ts) holds the buttons. The adapter contract is `CardCapableAdapter` in [`packages/types/src/platform.ts`](https://github.com/ethosagent/ethos/tree/main/packages/types/src/platform.ts).

## Mapping {#mapping}

Every model-supplied string is HTML-escaped; only a `text` card's body is read as Markdown.

| Kind | Telegram form | Fidelity |
|---|---|---|
| `text` | Bold title, then the Markdown body as Telegram HTML. | Full. |
| `code` | Bold title, then a `<pre><code class="language-x">` block. | Full. |
| `alert` | Severity glyph, bold title, message. Glyph and wording carry the severity, never colour alone. | Full. |
| `detail` | Bold title and italic status, then one `label: value` line per field. | Full. |
| `item_list` | One line per item: status glyph (green, yellow, red, white), bold name, italic meta, `id` as plain text. | Degraded: no link. |
| `data_table` | A `<pre>` grid with numeric columns right-aligned and a totals row. A grid wider than 48 columns becomes one `label: value` block per row. | Full; degraded when wide. |
| `metric_chart` | Per series: name, a text sparkline (at most 40 sampled points), first to last value, min and max, the y label. | Degraded to text. |
| `recommend_actions` | The question (or `Next?`) and an inline keyboard with one button per row. | Full. |
| `canvas` | Bold title and a pointer to open the chat on the web. `render_ui` is refused on Telegram, so this is unreachable today. | Degraded to text. |

Long output splits at 4 096 characters with balanced tags per message, and the keyboard rides the last one. If Telegram rejects the HTML, the adapter re-sends the same text with the tags stripped.

## Posting {#posting}

- The gateway posts, not the adapter. It validates `tool_end.structured.card` against `CardEnvelopeSchema` and drops an invalid envelope with a `gateway.card_invalid` event.
- Data cards post when the tool ends. `recommend_actions` waits until the answer has been sent, so its buttons sit under it. A turn that errors or is stopped drops the held card.
- An identical card for the same inbound message posts once. The same card answering a different message still posts.
- A card post is best-effort and owes no delivery-ledger row. A failed post records `gateway.card_post_failed`, and the answer still lands.

## Buttons {#buttons}

A `recommend_actions` button sends its `prompt` as the tapper's next message. The card then edits itself to the question and `→ <label>`, and its buttons go away.

| Tap | Result |
|---|---|
| First tap on a live card | The card is settled, edited in place, and the prompt runs as a user turn from the tapper. In a group it passes mention gating, and normal admission applies. |
| Any later tap | Toast `Already chosen.` No turn. |
| Token older than 48 hours, unknown, or its record deleted | Toast `This button has expired — type the request instead.` The keyboard is stripped. No turn. |

Buttons carry `rca:<token>:<index>`, and the prompts live in `~/.ethos/telegram/<botKey>/card-actions.jsonl`, written through `Storage`. The map survives a gateway restart. Without a `Storage` it is memory-only, and every button reads as expired after a restart. Anyone in a group may tap, because the turn runs as the tapper. The tap rules are pinned by `extensions/platform-telegram/src/__tests__/live-card.test.ts`; the token store by `extensions/platform-telegram/src/__tests__/card-action-store.test.ts`.

## See also {#see-also}

- [Card catalog](./card-catalog.md) — payload fields, caps and the surface boundary.
- [Telegram adapter](../../platforms/telegram.md) — running the bot that draws these cards.
