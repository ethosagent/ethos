# Design system: sidebar and interaction states

[Back to the design system](../../DESIGN.md)

## Sidebar

### Icons
Every nav item **must** carry a 16px stroke SVG icon (`stroke="currentColor"`, `strokeWidth="1.5"`, `fill="none"`). Text-only nav is forbidden — the collapsed/icon-only rail must remain navigable. No emoji as nav icons.

Icon assignments:

| Route | Icon description |
|---|---|
| Chat | Speech bubble (rounded rect + tail at bottom-left) |
| Sessions | List with leading dots (3 rows) |
| Personalities | Person silhouette (circle head + arc shoulders) |
| Skills | Lightning bolt / zap |
| Memory | Brain (rounded irregular organic shape) |
| Activity | Bar chart (3 ascending vertical bars) |
| Cron | Clock (circle + hour/minute hands) |
| Communications | Envelope |
| Mesh | Three circles connected by lines |
| Teams | Two person silhouettes |
| Platforms | Globe / world outline |
| MCP | Hexagon with connecting lines |
| Batch | Stack of documents |
| Eval | Checkmark in a box |
| Plugins | Plug (rectangle + 2 prongs) |
| Settings | Gear / cog (circle + teeth) |
| Overview | House (roof + walls) |
| Structure | Three circles linked by lines (one above two) |
| Channels | Envelope (same glyph as Communications) |
| Board | Three vertical bars (same glyph as Kanban) |
| Learning | Inbox tray (open tray with a notch where proposed changes wait) |
| Recipes | Open book (two facing pages joined at a centre spine) |
| Tasks | Checklist (two ticked rows, each a checkmark beside a line) |
| Dashboards | Panels (four rectangles of unequal height in two columns) |
| Admin | Shield (with a checkmark inside) |
| System cron | Clock (same glyph as Cron) |
| Documents | Page with a folded top-right corner and two text lines |
| Schedule | Clock (same glyph as Cron) |
| Outbox | Tray with an upward arrow above it (the draft has not gone out yet) |
| Goals | Target (two concentric circles) |
| Identity | ID card (head-and-shoulders portrait beside two text lines) |

### Active state
`background: rgba(74,158,255,0.18); border-left: 2px solid #4A9EFF; padding-left: 10px` (compensate padding for the 2px border). Text color: `var(--text-primary)` (full brightness — not dimmed blue).

Previous spec of 12% opacity was too low to read; 18% is the correct value.

### Section dividers
Nav group separators are **thin lines** (`height: 1px; background: var(--border); margin: 4px 12px`) rather than uppercase label text. Retain group labels but reduce to `opacity: 0.35` and remove `text-transform: uppercase` — they become structural hints, not headings.

### Desktop icon-only rail
Desktop sidebar is 64px wide and always icon-only. Active state uses background + a 2px × 16px rounded bar flush to the left edge (not a full left-border since there's no label text to offset against).

### Teams (third altitude)

A team is a scope beside Library and Workspace, not a page inside the Library. It
keeps the rail and gets its own contextual column. The column's rows, in order:

1. **Chat** — with a `via <coordinator>` hint in Geist Mono 11px beside a 12px mark
2. divider
3. **Overview**, **Board**, **Structure**, **Memory**, **Activity**, **Channels**, **Settings**
4. divider
5. `RECENT IN <TEAM>` — the recent-sessions block filtered to the team's members

The breadcrumb reads `<ring> <team> ▾ / <pane>`. The `▾` on the team name is the
**scope switcher**, and it is the breadcrumb root at every altitude: Independent
(the Library and per-agent workspaces), each team, and New team. Team chrome is
neutral (see "Per-personality accent"); the segmented ring is the team mark (see
"Personality marks → Altitude convention").

## Interaction states

### Hover / pressed tints
All hover and pressed backgrounds use **CSS variables** (not hardcoded `rgba(255,255,255,...)` values, which break in light mode):

| Variable | Dark value | Light value |
|---|---|---|
| `--ethos-hover` | `rgba(255,255,255,0.07)` | `rgba(0,0,0,0.05)` |
| `--ethos-pressed` | `rgba(255,255,255,0.12)` | `rgba(0,0,0,0.09)` |
| `--ethos-surface-tint` | `rgba(255,255,255,0.04)` | `rgba(0,0,0,0.03)` |
| `--ethos-shadow-overlay` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.12)` |

These are emitted by `tokensToCssVariables()` in `packages/design-tokens/src/antd.ts` using `isLightSurface()` to branch. **Never hardcode white-alpha tints in CSS** — always use the variable so skins work correctly.
