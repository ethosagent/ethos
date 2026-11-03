# Design system: Call Stage and CallStrip

[Back to the design system](../../DESIGN.md)

### Call Stage

Talk-mode's primary surface is a **mode, not a dialog**. Starting a call switches
the Chat page **into** Call Stage; ending the call returns it to normal chat.
Nothing floats over the conversation, because while a call is carrying audio the
call *is* the conversation. This reverses the earlier "no new full-screen
surface" line: a call is not a status cue, and a 10px dot is not enough surface
to carry three continuously-changing states.

**Two** columns, filling the chat tab:

| Column | Width | What it holds |
|---|---|---|
| Stage | flexible | The shape on canvas, the personality's name, the mono state word, mute + end, and a Geist Mono `{provider} · {model} · NNNms` footer. |
| This call | 320px | **This call's** turns, newest last — not chat history. A header reading `This call` plus the **Back to chat** control. At its base, the reserved clarify slot. |

**There is no left navigation rail, and that is the decision.** A rail is an
invitation to move around the UI, and moving around the UI mid-sentence is
exactly what a call cannot afford. The only column worth looking away to is the
one that says what is happening in *this* call. Nothing else earns a column.

The PersonalityBar is **not** rendered in this mode either, for the same reason:
rename and new-session are the wrong things to offer someone who is
talking. Identity is carried by the stage itself — the accent-coloured shape
holding the personality's initial, and the name beneath it.

Below 760px the transcript's turns and clarify slot drop, as before. The column
itself does **not**: it now carries the only exit that is not a hang-up, so it
collapses to its header row and restacks under the stage — one line holding
`This call` and a 44px `Back to chat`. The controls and the way back to text are
never what gets cut.

**Enter and exit are automatic and derived from the CALL, never from the drawn
state** (`callStageMounted`). A live call is the mode through every status it
passes through, including `connecting` and `reconnecting`. Degraded, mic-denied
and ended return to normal chat, where the CallStrip carries the explanation and
the way to act on it. The only manual exit is **Back to chat**, a single small
text button in the transcript header — not a rail, not a second mechanism. It
collapses the mode without hanging up: the Reconnecting row below promises the
composer stays usable for text, and in a mode this is what keeps that promise.
Only hang-up and `Esc` end a call.

#### The reserved clarify slot

The slot sits at the base of the transcript column for the whole call — dimmed,
reading `No open question`, when there is nothing to answer — and a mid-turn
`clarify` **fills it in place**. A reserved slot rather than a popup, because
things appearing and disappearing mid-call read as instability, and attention
for a surface that just moved is the one thing a person on a call cannot spare.
The slot holds its own height and does not flex; the scrolling turn list above
absorbs the difference, so filling it moves nothing on screen.

Off-call the clarify card is unchanged: it still floats over Chat as an
`alertdialog`. Both are the same component and resolve through the same
`clarify.respond` / `clarify.resolved` path — in the slot it is a labelled
region, not an alert, because nothing was interrupted by its arrival.

Three treatments, all driven by the same amplitude signal:

| Treatment | Value | What it is |
|---|---|---|
| Liquid | `liquid` | The personality circle fills like a vessel; the surface is two summed sines, so it reads as liquid rather than a progress bar. |
| Orb | `orb` | A radial-gradient body whose rim deforms with amplitude. |
| Rings | `rings` | Three concentric rings breathing outward from a solid core. |

**Which one a call draws is the personality's, not the app's.** The shape is
identity — the same argument the accent already won — so a personality declares
it as `voice.call_style`, edited in its Identity step next to the voice fields.
It is optional and there is no "unset" look: an undeclared personality gets a
treatment derived from its id, deterministically, so a fresh install already
shows five agents that do not look alike. `display.call_style` sits between the
two for operators who want one shape everywhere; its default, `personality`, is
not a pin. The order is one function — `resolveCallTreatment` in
`packages/types/src/personality.ts`:

1. the personality's `voice.call_style`
2. `display.call_style`, when it names a concrete treatment
3. derived from the personality id

Color is `display.call_accent`: `personality` (default — follows the active
personality's accent, so the shape says *which* agent holds the floor) or an
explicit hex. `display.call_style` and `display.call_accent` are edited in
Settings → Voice → Call appearance. Nothing else about the stage is
configurable — the motion constants are fixed in code.

#### Motion class: continuous amplitude-driven motion

This is a **new motion category**, and the first one added to this system. The
scale below (80 / 180 / 240ms, "no bounces or springs") describes *state
transitions*: something changes, the change takes a fixed time, the motion ends.
A duplex call has no such moment to animate. What the listener needs — is it
hearing me, is it working, is it talking — is true continuously and has to be
shown continuously, so the shape is driven by an audio amplitude signal for as
long as the call is up. The transition scale still governs everything else about
the stage (entering the mode, hover, focus ring).

The motion constants — smoothing, gain, travel, wave speed, glow, orbit rate —
are **fixed in code**, not exposed: `CALL_MOTION` in
`apps/web/src/features/voice/call-motion.ts`.

#### States

| State | What the user sees |
|---|---|
| Listening | The shape in `--error` red — the live-mic vocabulary the composer's `AudioBars` already uses. Amplitude is the mic level. |
| Thinking | **Amplitude-independent** — nobody is talking. The circle contracts to 84%, a comet arc orbits it, and a slow 0.5Hz breath keeps the shape alive at rest. Accent-colored. |
| Speaking | Accent-colored, amplitude driven by the agent's own output level (an analyser on the playout graph). |
| Connecting / Reconnecting | Rendered **inside** the stage, not instead of it: the Thinking shape (busy, accent, amplitude-independent — nobody is talking) with the mono state word reading `connecting` / `reconnecting…`. The stage is mounted by the call, never by the state — unmounting it for a status a live call passes through replays the 240ms entrance and restarts the canvas, which the user reads as the whole surface flickering out and back between turns. Text stays reachable throughout via **Back to chat**. |
| Degraded / Mic-denied / Ended | The mode ends, Chat returns to normal, and the CallStrip takes over. These are the states where what the user needs is the explanation and a way to act on it, and the strip is what carries both. |

`prefers-reduced-motion`: the comet collapses to a **static ring** — no orbit, no
wave, no glow, and the amplitude smoothing drops out so nothing drifts after the
signal stops. State stays legible without a frame of motion: the color, the
contraction and the mono state word carry it.

Controls are ≥44px touch targets. The provider label stays Geist Mono
`{provider} · {model}`, the same vocabulary as the TopBar and the strip.

### CallStrip

What normal chat shows for a call: the form the Call Stage collapses to, and the
only form for the states that are not carrying audio (degraded, mic-denied, a
call that ended with something left to explain). One slim strip on Chat —
**rows, never the `Card` primitive**.
Nine states, all in existing vocabulary:

| State | What the user sees |
|---|---|
| Idle / entry | No strip. 16px stroke mic glyph in the composer card next to send; "Try voice" pill in the empty-chat grid. |
| Connecting | 10px amber (`--warning`) dot pulsing via `status-dot-pulse` + `connecting` in Geist Mono. |
| Listening | Red `AudioBars` mic meter. |
| Thinking | The accent dot **steady** — the personality has the floor but is not talking yet. |
| Agent speaking | The same 10px accent dot **pulsing** + the live caption line in `--text-secondary`. |
| Barge-in acknowledged | Caption truncates; one `--motion-default` accent flash; the line stays in the transcript marked `[interrupted]`. |
| Reconnecting | Amber dot + `reconnecting…`; the composer stays usable for text. |
| Degraded to text | The strip collapses to a dismissible inline **row**: "Voice unavailable — provider X failed; continuing in text." |
| Mic permission denied | An inline row with the browser's re-grant path. Never a dead mic icon. |

The provider that served the turn and its latency render as **Geist Mono
`{provider} · {model}` + `NNNms`** — the same label vocabulary as the TopBar.
Not a badge, not a debug panel. The per-stage breakdown sits behind an
expandable toggle, collapsed by default.

Controls are ≥44px touch targets; `prefers-reduced-motion` stops every pulse and
the barge-in flash. At 375px the mark, state and mute/end persist and the mono
detail collapses behind the toggle's tap.

While a call is carrying audio the strip also carries the control that returns to
the Call Stage — collapse and restore are the same call, not two surfaces.
