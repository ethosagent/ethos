# Design system: personality marks and cross-surface token mapping

[Back to the design system](../../DESIGN.md)

## Personality marks (generative SVG)

Deterministic geometric marks per personality. Same algorithm runs at render time on every surface — no asset pipeline, no PNG bundle.

**Algorithm:**
1. Hash personality `id` (FNV-1a 32-bit)
2. 5×5 grid, mirror-symmetric (cells `[0..2]` mirrored to `[3..4]`)
3. Each cell filled based on a bit from the hash; opacity 0.55–0.93 from next 2 bits
4. Background: circular frame — a `<circle>` at accent color `0x22` alpha, plus a 1.5px accent ring stroke at ~0.55 opacity around the circumference (strokeWidth scales: `size * 0.04`, minimum 1). Cells are clipped to the circle via `<clipPath>`. Echoes the circular ring logo (`logo.svg` annulus).
5. Filled cells: solid accent at the computed opacity

**Altitude convention:** the Ethos annulus (`apps/desktop/assets/brand/ethos-mark.svg`)
marks the machine altitude — the Library, not any single agent. Agents get generative
marks (this algorithm, per personality); Ethos gets the ring. A team gets a
**segmented ring** — one arc per member, in that member's accent, in manifest order
starting at 12 o'clock, with a faint neutral fill inside. It is built from the members,
so it is neither a generative mark (an agent) nor the annulus (the machine). Three
marks, three altitudes; none inherits another: a personality does not inherit the
annulus, the machine altitude does not generate a mark, and a team's ring is assembled
from its members, not hashed from an id.

The segmented ring renders at 14px (breadcrumb), 18px (switcher rows), 22–30px
(column identity, rail) and 36px (team Overview). Arc stroke width is
`max(1.5, size * 0.09)`; the gap between arcs is `min(3px, 18% of an arc)`. Same
algorithm on every surface. TUI fallback: `◔ ◑ ◕ ●` by member count. Reference
implementation in `apps/web/src/components/ui/TeamRing.tsx`, with the algorithm twin
in `packages/web-contracts/src/marks.ts`.

Reference implementation in `apps/web/src/components/ui/PersonalityMark.tsx`. Same algorithm available as `packages/web-contracts/src/marks.ts` so server-side rendering and TUI ASCII fallback can use it.

For TUI: render as a 4×4 unicode block-character grid using `▓▒░` characters with the personality's ANSI accent. Same hash, same symmetry, just lower fidelity.

## Cross-surface token mapping

Ethos lives across surfaces. The single source of truth is hex values and font choices in this file. Each surface reads them differently:

| Token | Web (CSS var) | TUI (ANSI 256) | VS Code (theme) | Email digest | CLI (chalk) |
|---|---|---|---|---|---|
| accent · researcher | `#4A9EFF` | `\x1b[38;5;39m` | matches editor accent | `#4A9EFF` brand | `chalk.hex('#4A9EFF')` |
| accent · engineer | `#4ADE80` | `\x1b[38;5;41m` | (same) | (same) | `chalk.hex('#4ADE80')` |
| accent · reviewer | `#F59E0B` | `\x1b[38;5;208m` | (same) | (same) | `chalk.hex('#F59E0B')` |
| accent · coach | `#E879F9` | `\x1b[38;5;207m` | (same) | (same) | `chalk.hex('#E879F9')` |
| accent · operator | `#94A3B8` | `\x1b[38;5;247m` | (same) | (same) | `chalk.hex('#94A3B8')` |
| bg-base (dark) | `#0F0F0F` | (terminal default) | `--vscode-editor-background` | (light only) | (terminal default) |
| text-primary (dark) | `#E8E8E6` | `\x1b[38;5;253m` | `--vscode-foreground` | `#1A1A1A` | (terminal default) |
| mono | `Geist Mono` | (terminal mono font) | `editor.fontFamily` | `monospace` fallback | (terminal default) |

### Per-surface notes

- **CLI:** colorless by default. Apply `--accent` only via `chalk` for personality-tagged log lines and tool chips.
- **TUI (Ink):** `<Text color="#4A9EFF">` syntax in Ink wraps to ANSI escape codes. Generative marks render as 4×4 unicode block-character grids.
- **VS Code extension:** uses `--vscode-*` tokens for chrome (so VS Code's user theme stays consistent). Per-personality accent only on personality-specific affordances (chat header stripe, tool chip icon).
- **Email digests:** light mode only (most email clients render dark mode poorly). Single brand accent (`#4A9EFF`) — no per-personality fingerprint in digests because they aggregate across personalities.
- **Web UI:** the full system; this file's primary consumer. Applied via Antd `ConfigProvider` theme tokens, see `apps/web/src/lib/theme.ts`.
