---
paths:
  - "apps/web/**"
  - "apps/desktop/**"
  - "apps/tui/**"
  - "packages/ui-components/**"
  - "packages/design-tokens/**"
---

# UI and design system

API response type safety
Never cast API response types with `as`. The oRPC typed client infers return types — use those. For SSE events, parse with the Zod schema from `@ethosagent/web-contracts`. For external JSON (localStorage, URL params), use Zod `.safeParse()` with a fallback rather than `as`.

Design system
Always read DESIGN.md before making any visual or UI decision. All font choices, colors, spacing, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

The web UI (in development) references DESIGN.md tokens via Antd ConfigProvider. Other surfaces (TUI, VS Code extension, email digests, CLI) consume the same tokens — see DESIGN.md "Cross-surface token mapping" for the per-surface render rules.

When reviewing or writing code that touches UI, flag any deviations from DESIGN.md (slop blacklist, font choices, color hex values, motion durations, "cards earn existence" rule).

