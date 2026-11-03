# Design system: chat surface

[Back to the design system](../../DESIGN.md)

## Chat surface

### User message bubbles
`border-radius: 12px 12px 4px 12px` — top-heavy asymmetric radius (conversational, not boxy). The `sm` (4px) token is for chips and buttons only; never use it on chat bubbles.

Background: `var(--bg-overlay)`. Padding: `10px 16px`. Max-width: 75%.

### Composer
The composer is a **unified bordered card** — not a bare textarea with a button beside it.

- Container: `border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-elevated); padding: 10px 10px 10px 16px;`
- Send button: icon-only circular button (32px diameter, `border-radius: 9999px`, `background: var(--accent)`). Arrow SVG icon. No text label. Disabled state: `background: var(--bg-overlay)`.
- The `border-top` line separator above the composer is removed — the card container provides visual separation.

### Feedback & activity
The user always sees what the agent is doing and what it did; the answer itself is never interrupted by machinery; every request is visibly acknowledged within the first second.

1. **The answer is content only.** An assistant bubble holds text, images, HTML, PDF, cards and the delegated-run card — things the agent made *for* the reader. It never holds tool chips, badges, pills or status. (`tool` blocks stop being appended to `turn.blocks`.)
2. **The status line** sits directly above the composer, inside the 800px column, in a **reserved slot** from the moment a message is sent until the turn's footer replaces it, so nothing moves. Geist Mono 13px `--text-secondary`; the accent dot steady for `received` and `thinking`, pulsing for a running tool; elapsed time in `--text-tertiary` tabular numerals. Phases: `received` (on send, before any event) → `thinking` → `{tool} · {argsPreview}` → `writing` (elapsed only — the words are the feedback). After 20 s without an event it appends `⚠ still working` (`--warning`, glyph + word). It is a `role="status"` `aria-live="polite"` region, announcing on send and on each tool change, throttled to one announcement per 2 s.
3. **The trail** is one collapsed line above the reply, so what the agent did reads before its answer: `✓ 4 actions · ⚠ 2 unverified · 12.4s ▸` (`<button aria-expanded>`, Geist Mono 13px `--text-secondary`, durations `--text-tertiary`). Expanded, it is the drawer's dense rows: glyph + word (✓ ok / ✗ failed / ⚠ unverified — never colour alone), tool name in mono, one-line args, duration right-aligned tabular; 28px rows, `sm` radius hover tint `--ethos-hover`. An aborted turn ends with `✗ stopped · 2 actions`. Zero actions → no footer. Zero findings → no "verified" (fail-open must not fabricate assurance).
4. **One trail, two renderers.** A per-turn `trail` structure in the chat reducer is derived from live `tool_start`/`tool_end`/`tool_progress` *and* from persisted tool messages on history load. The footer renders `trail[turnId]`; the drawer renders the same trails grouped by turn (a header row: relative time + the first words of the user message). They cannot disagree, and yesterday's replies have trails (durations show `—` when history lacks them).
5. **Findings are trail rows.** A grounding finding, a blocked-page hint, a profile-fallback warning: `⚠` + the word, the claim quoted in mono, the evidence in `--text-secondary`; the row is a button that focuses the tool row it cites. In `correct` mode the next reply's first paragraph is preceded by one mono label `correction · re: "tests pass"` — the only chrome.
6. **Feedback rows outside chat.** Any action a page takes — a backup, a probe, an install stage, an observe heartbeat — is a row: glyph + word, mono subject, mono timestamp or duration, result text. The same row the trail uses. Persistent, never a toast; outcomes resolve the row in place, they do not remove it.
7. **Nothing vanishes.** A waiting card (clarify, takeover) resolves to a row stating the outcome; it never disappears. (Call Stage lesson, 2026-08-14.)

### Empty chat state
When `messages.length === 0` and no turn is active, the chat surface shows a centered empty state (not a placeholder sentence):
- 48px PersonalityMark SVG
- Personality name (16px, 500 weight)
- Model in monospace (13px, secondary)
- "Ready to help." (14px, secondary) — no marketing copy
- 2×2 suggestion pill grid: `border: 1px solid var(--border); border-radius: 9999px; padding: 8px 20px; background: var(--bg-elevated)`. Each pill pre-fills the composer on click.
- Suggestion sets are per-personality — see `apps/web/src/components/chat/MessageList.tsx` for the full set.

### Connection status indicator
Three-state dot (8px circle, `border-radius: 9999px`):
- **Connected**: `#4ADE80` (solid)
- **Connecting**: `#F59E0B` (pulsing — reuse `thinking-bounce` keyframe)
- **Offline**: `#F87171` (solid)

Web surface: rendered in TopBar right-hand side alongside `{provider} · {model}` mono label.
Desktop surface: rendered in sidebar bottom as an 8px dot inside a 20px glow ring (`border: 1.5px solid rgba(74,222,128,0.4)`).

**Extended for a microphone (SatelliteRow, voice V3).** A wake satellite has
states a websocket does not, so the same `.sb-dot` base gains three modifiers
rather than a second dot being drawn:

- **Listening**: `#4ADE80` (solid) + three CSS liveness bars. The bars are a
  cue, not a meter — the node protocol carries no amplitude, and inventing
  levels would be the dishonest version of "the mic is armed".
- **Speaking**: `var(--accent)` (pulsing) — the same "the agent has the floor"
  vocabulary as the CallStrip.
- **Muted**: `--text-tertiary` (solid).
- **Wake off**: **hollow** — transparent fill, 1.5px `--text-tertiary` ring.
  Hollow rather than a second grey because wake-off is *persisted* and muted is
  momentary, and the indicator-honesty rule is worthless if the two look alike.
- **Degraded**: `#F87171` (solid), with the failing probe named inline.

`prefers-reduced-motion` stops the pulse and the bars; the bars hold their
tallest height so the row still reads as armed.

### Personality bar

The bar at the top of the chat tab is **identity, read-only**: accent stripe,
mark, name, model. It carries no control that changes which personality the
conversation is with, because a session belongs to the personality it started
with. The two controls it does carry act on the session, not on identity —
rename, and `+` to start a new one (which is where a personality gets chosen,
via the New Session picker). The same rule holds everywhere in the web UI: the
command palette offers no "switch personality" verb, and a `?personality=`
deep-link is honoured only alongside `new=1`.
