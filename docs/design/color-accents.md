# Design system: personality, runner and decision accents

[Back to the design system](../../DESIGN.md)

### Per-personality accent (the load-bearing identity affordance)

The chat tab swaps the accent per active personality two ways at once, from one
resolver (`personalityAccent` in `apps/web/src/lib/theme.ts`): a second
`<ConfigProvider>` carries it as Antd's `colorPrimary`, and the element that
provider wraps carries it as `--accent`. Both are needed — a `ConfigProvider`
renders no DOM node, so raw CSS cannot read a variable off it. In Call Stage the
same element carries the call's accent instead, which is the personality's unless
`display.call_accent` pins a hex.

Accent flows through:

| Flow | Where it lives |
|---|---|
| Personality bar accent stripe (3px tall) | `PersonalityBar.tsx`, inline `background` |
| Composer caret color | `input, textarea { caret-color: var(--accent, …) }` |
| Send button background (and its hover, which brightens the accent rather than naming a second blue) | `.composer-send-btn` |
| Focus ring (`outline: 2px solid var(--accent); outline-offset: 1px`) | 17 `:focus-visible` rules in `styles.css` |
| Link color in agent text | `.message-assistant a` |

The rule survives; its premise does not. The previous statement of this rule held
because "the rail is outside the personality subtree" — true only while a single
flat sidebar was the entire chrome. The two-altitude IA (`◎` Library / per-agent
Workspace) introduces a contextual column that **is** the personality subtree, so
the rule is restated by scope rather than by widget:

**Global chrome stays neutral; scoped chrome carries the scope's identity.** The
altitude rail is global chrome and keeps `--ethos-info` forever. The contextual
column and the stage carry the active scope's accent. The furniture moves only
when you have walked into a different room.

**Team chrome is neutral**, because a team's identity is plural. The team panes
(Overview, Board, Structure, Memory, Activity, Channels, Settings) run on
`--ethos-info` like the Library. Inside a team, a member's workspace
(`/t/:teamId/p/:id/*`) carries that member's accent exactly as `/p/:id/*` does. The
team **Chat** pane carries the coordinator's accent, because it is the coordinator's
surface. The rail stays neutral at every altitude.

The personality accent table lives in [DESIGN.md](../../DESIGN.md#color).

### Runner accent (a foreign process is not a personality)

A **runner** is an external coding harness Ethos delegates a job to — Pi today,
another harness later. It gets an accent for the same reason a personality does:
you have to be able to tell at a glance whose work you are looking at. It does
**not** get a personality accent, and it is not a sixth row in the table above.
The table is the roster of agents that live here; a runner is a process Ethos
handed work to, and blurring the two would say the wrong thing about what Pi is.

| Runner | Dark | Light | Reasoning |
|---|---|---|---|
| pi | `#2DD4BF` | `#0D9488` | Teal — outside the five personality hues and outside the semantic four, so it can never be read as an agent's identity or as a status signal |

Two rules, both load-bearing:

1. **Runner identity is data, not CSS.** Every runner accent, label, and badge
   string is consumed through a single `RUNNERS` identity map
   (`{id, label, accent, badgeText}`, `apps/web/src/lib/runners.ts`). No
   component hardcodes a runner's hex, its badge text, or the literal `pi` — a
   second harness must be a map entry, never a diff across the render tree. Copy
   is templated on `{runner}`.
2. **A runner accent is not an `--accent`.** The per-personality accent swap
   (above) is unaffected: a delegated run's chrome carries the runner's hue
   *within the run's own surface*, and the surrounding scope keeps the
   personality's. The two never trade places.

### Decision accent (a decision model's work in the trail)

A **decision** row says that a decision model (Jev today) ran for this turn —
the router picking a model, the approver judging a call, the injection
classifier reading a tool result — what it decided and how long it took
(plan `decision-provider-personality.md` §15). It needs a hue for the same
reason a runner does: you tell at a glance that this row is not the agent's own
tool call.

| Token | Dark | Light | Reasoning |
|---|---|---|---|
| `--decision` | `#2DD4BF` | `#0D9488` | The runner-teal values. A decision model is also a foreign process doing work on the agent's behalf, and teal already means exactly that; a seventh hue would be one more thing to learn for no new meaning |

Rules:

1. **It takes the runner-teal values; it is not the runner accent.** The pair is
   consumed through the decision identity map (`apps/web/src/lib/decision-providers.ts`,
   which reads it from `RUNNER_TEAL` in `apps/web/src/lib/runners.ts` — still the
   only file holding the hex) and stamped once on `:root` as `--decision` per skin
   (`main.tsx`). The provider's label (`Jev`) and tag (`jev`) come from the same
   map; no component hardcodes the hex or the literal `jev`.
2. **It is not an `--accent`.** Runner rule 2 holds unchanged: the personality's
   hue stays the personality's.
3. **Where it appears:** the decision row's tag and state word, the trail
   footer's decision segment (`3 decisions 118 ms`), and the status line's dot
   while an `on` decision holds the loop (`jev checking read_file result`). A row
   that warns or fails takes `--warning` / `--error` instead. Always glyph +
   word (`✓ decided`, `⚠ observed`, `✗ skipped`), never colour alone. The CLI
   maps it to the terminal's cyan.
4. **The answer bubble stays content-only** (Feedback & activity rule 1). The
   router's decision is the trail's first row, not model-line chrome.
