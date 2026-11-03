# Ethos · Design System

**The agent team is present.** Each personality has a face. The chat surface fingerprints which agent you are talking to. This system delivers that across CLI, TUI, VS Code extension, web UI, and email digests.

> Always read this file before making any visual or UI decision. All font choices, colors, spacing, and aesthetic direction live here. Do not deviate without explicit user approval.

## Product context

- **What this is:** TypeScript AI agent framework where personality is architecture
- **Who it's for:** developers, terminal-adjacent power users
- **Project type:** multi-surface developer tool (CLI / TUI / VS Code / web UI / email / platform adapters)
- **Memorable thing:** the agent team is PRESENT. Each personality has a face — generative mark + accent color + voice. Distinguishes vs anonymous-LLM chatbots.

## Aesthetic direction

- **Direction:** Industrial / Utilitarian + identity-forward
- **Decoration level:** minimal — typography and per-personality accents do all the work. No grain, no texture, no decorative SVG, no gradient backgrounds.
- **Mood:** terminal-adjacent, honest, dense-but-readable. Linear-density meets Vercel-typographic-restraint with personality.
- **Reference points:** Linear (calm density, sidebar nav), Vercel (typographic restraint), GitHub identicons (deterministic generative marks)

## Typography

- **Display / UI:** `Geist` — 400 (regular) / 500 (medium) / 600 (semibold). No italics in UI chrome.
- **Mono / code / tool args / data:** `Geist Mono` 400. Used for: model names, tool names, tool arguments, kbd hints, file paths, tabular numbers, timestamps.
- **Loading:** self-hosted via npm `geist` package on web; system font fallback `'Geist', system-ui, sans-serif` and `'Geist Mono', monospace`. Never `Inter`, `Roboto`, `system-ui`, `-apple-system` as the primary display font.
- **Why:** Geist is the current right pair for serious developer tools. The mono is excellent and the proportional has restraint without being neutral.

### Scale

| Role | Size | Weight | Line height | Letter spacing |
|---|---|---|---|---|
| h1 / hero | 32px (2rem) | 600 | 1.2 | -0.01em |
| h2 | 24px (1.5rem) | 600 | 1.25 | 0 |
| h3 | 20px (1.25rem) | 600 | 1.3 | 0 |
| h4 / strong-body | 16px (1rem) | 500 | 1.4 | 0 |
| body | 14px (0.875rem) | 400 | 1.5 | 0 |
| small | 12px (0.75rem) | 400 | 1.4 | 0 |
| micro / section labels | 11px (0.6875rem) | 500 | 1.4 | 0.08em (uppercase) |
| mono | 13px (0.8125rem) | 400 | 1.45 | 0 |

`font-variant-numeric: tabular-nums` on all mono content — tables, tool-chip metadata, usage counters, timestamps.

## Color

Dark mode is **primary**. Light mode is **supported but not optimized** (used by some users in bright environments — must be readable, not a marketing surface).

### Surface tokens

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg-base` | `#0F0F0F` | `#FAFAF7` | App background. Paper-warm, not pure black/white. |
| `--bg-elevated` | `#1A1A1A` | `#FFFFFF` | Sidebar, drawer, modal, card primitive |
| `--bg-overlay` | `#2A2A2A` | `#F0F0EC` | Hover, pressed states, user message background |
| `--border-subtle` | `#2A2A2A` | `#E8E8E4` | Default borders |
| `--border-strong` | `#3A3A3A` | `#D0D0CC` | Emphasized borders, dividers |
| `--text-primary` | `#E8E8E6` | `#1A1A1A` | Main body text. Contrast ~14:1 / ~17:1 |
| `--text-secondary` | `#9A9A98` | `#585857` | De-emphasized text. Contrast 6.80:1 / 6.81:1 |
| `--text-tertiary` | `#7E7E7D` | `#70706B` | Muted, captions, section labels. Contrast 4.72:1 / 4.76:1 — WCAG AA for normal text, because the feedback contract puts durations here at 13px |

### Semantic colors

Used **only** to signal status, never as decoration. Always paired with an icon — never color alone.

A semantic colour is tuned to the ground it sits on, so it has a dark and a
light value. A personality accent does **not** — an identity hue is the same
hue in both skins. Where a dark semantic and an accent share a hex they are
still two different tokens that happen to agree on the primary skin: `--warning`
is not the reviewer accent, and retuning one must never move the other.

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--success` | `#4ADE80` | `#177D3C` | Success states, completed tools. Dark value coincides with the engineer accent; the light value does not |
| `--warning` | `#F59E0B` | `#986206` | Pending review, soft warnings. Dark value coincides with the reviewer accent; the light value does not |
| `--error` | `#F87171` | `#CE2C2C` | Distinct red, never a personality color — failures, rejections |
| `--info` | `#4A9EFF` | `#4A9EFF` | Informational tags, neutral notifications. The one semantic that does not retune: it is the researcher hue and the permanent altitude-rail blue, so it moves only as an accent decision |

Light values keep their dark counterpart's hue and drop lightness until the
pair clears WCAG AA on `--bg-base` (4.98 / 4.92 / 4.99:1); red also eases its
saturation so a 5:1 red reads as brick rather than siren beside the ochre and
the forest green. `--info` on paper-warm is 2.63:1 and is a known shortfall —
see the 2026-09-04 decisions-log row.

## Spacing

Base unit: **8px**. Density: **comfortable** — not data-dashboard compact, not marketing-spacious. Linear-density.

```
xs  4px
sm  8px
md  12px
lg  16px
xl  24px
2xl 32px
3xl 48px
4xl 64px
5xl 96px
```

## Layout

- **Approach:** grid-disciplined for app surfaces; single-composition for onboarding steps
- **Web sidebar:** 240px expanded / 64px collapsed
- **Web right drawer:** 360px (toggleable, default visible at ≥1280px)
- **Chat content max-width:** 800px (readable line-length)
- **Onboarding step max-width:** 520px (centered, generous vertical breathing)
- **Border-radius scale (hierarchical):**
  - `sm: 4px` — buttons, chips, tight UI chrome (NOT chat bubbles)
  - `md: 8px` — cards, modals, surface containers
  - `lg: 14px` — drawers, large surfaces
  - `full: 9999px` — pills, status dots, only on circular elements

### "Cards earn existence" rule

The `Card` primitive is reserved. It appears **only** on:
- Skill rows (Skills tab)
- Cron job rows (Cron tab)
- Task tiles (Teams Control Center board)

Everything else uses raw layout primitives. Tool chips are inline rows. Drawer streams are dense lists. Onboarding personality picker is stacked rows. No card grids anywhere.

The rule governs the `Card` **primitive**, not the word "card". A bordered
container assembled from raw primitives is not an exemption and never needed
one — `ClarifyCard`, the composer, and `CallStrip` are all built that way. The
three exemptions above share a property that is the actual test: each is a
**repeated list unit** whose alternative was a dense row, and each was granted
because the unit did not fit the row. A one-off container inline in a stream has
no dense-row alternative to be measured against, so there is nothing for an
exemption to buy — build it from primitives. The team Overview's attention tiles are
the Task tile exemption reused, not a new one; structure-canvas nodes, scope-switcher
rows and supervisor-ledger rows are bordered containers assembled from primitives.

## Motion

Single easing, short durations, no bounces or springs.

```css
--motion-fast:    80ms   /* hover, focus ring */
--motion-default: 180ms  /* state changes, tool chip transitions */
--motion-slow:    240ms  /* drawer, sidebar, modal slide */
--ease:           cubic-bezier(0.16, 1, 0.3, 1)
```

Transitions allowed on: `opacity`, `transform`, `color`, `background-color`, `border-color`, `outline-color`. **Never on text content** (no width-animating text reveals — they cause layout thrash).

`prefers-reduced-motion` → all motion is instant. `* { transition: none !important; animation: none !important; }`.

One exception to the scale, not to the preference: the Call Stage's
**continuous amplitude-driven motion** (see "Call Stage") is not a state
transition and has no duration token. It still stops under
`prefers-reduced-motion`, and it is the only place in the system allowed to move
without a transition.

## Voice (UI copy)

Honest, terminal-adjacent. No marketing copy. No "Welcome to Ethos!" / "Unlock the power of AI." No emoji as design elements (✓/✗/⏳ are status indicators, not decoration).

- Empty states are practical: "No skills installed. Try `claude/code-review` from ClawHub." Never "Looks like you don't have any skills yet! 🚀"
- Errors are concrete: "API key invalid — re-enter to continue." Never "Oops, something went wrong!"
- Buttons are verbs: "Send", "Approve", "Deny", "Schedule". Never "Get Started" or "Click Here".

## Anti-slop rules (the rules that keep the system honest)

The web UI specifically must avoid these patterns. Code review checks for them.

| Pattern | Why it's slop | Replacement |
|---|---|---|
| Purple/violet/indigo gradients | Default AI-generated app | Per-personality accent, solid colors only |
| 3-column feature grid with icons in colored circles | The most recognizable AI-template layout | Stacked rows with sample content |
| Centered everything with uniform spacing | Marketing-template feel | Left-aligned, asymmetric where appropriate |
| Bubbly border-radius on every element | Toy-app feel | Hierarchical scale (4/8/14/full) |
| Decorative blobs, floating circles, wavy SVG dividers | Filler | Empty space; let typography lead |
| Emoji as design elements | Lazy decoration | Status icons (✓/✗/⏳) only, never decorative |
| Colored left-border on cards | "We have to differentiate cards somehow" | Cards earn existence; differentiate via content |
| `system-ui` / `-apple-system` as primary display font | "I gave up on typography" signal | Geist + Geist Mono |
| Generic hero copy | Indistinguishable from every SaaS site | Specific, in-product language |
| Hover states that change layout | Layout thrash | `prefers-reduced-motion` honored; only opacity/color/transform |


## Where the rest lives

Moved verbatim to `docs/design/`. Section names are unchanged, so a citation such as `DESIGN.md § "Call Stage"` resolves to the page below.

| Sections | Page |
|---|---|
| Per-personality accent, Runner accent, Decision accent | [docs/design/color-accents.md](docs/design/color-accents.md) |
| Chat surface: user message bubbles, composer, feedback & activity, empty chat state, connection status indicator, personality bar | [docs/design/chat-surface.md](docs/design/chat-surface.md) |
| Call Stage (the reserved clarify slot, continuous amplitude-driven motion, states), CallStrip | [docs/design/call-stage.md](docs/design/call-stage.md) |
| Sidebar (icons, active state, section dividers, desktop icon-only rail, Teams as the third altitude), interaction states, hover and pressed tints | [docs/design/sidebar-and-interaction.md](docs/design/sidebar-and-interaction.md) |
| Personality marks (generative SVG, altitude convention), cross-surface token mapping, per-surface notes | [docs/design/marks-and-surfaces.md](docs/design/marks-and-surfaces.md) |
| The one approved card grid (the Recipes gallery), implementation notes, decisions log | [docs/design/decisions-log.md](docs/design/decisions-log.md) |
