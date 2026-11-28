import type { ToolResult } from '@ethosagent/types';

/**
 * Surfaces that can draw a card envelope (`emit_card`).
 *
 * Cards ride `tool_end.structured.card`. The web SPA renders them, and desktop loads that same
 * SPA. Telegram draws them natively: `TelegramAdapter` implements `CardCapableAdapter` and the
 * gateway posts the validated envelope (`extensions/gateway/src/card-post.ts`). Everywhere else —
 * CLI, cron, every other channel adapter — the answer is prose, because a card nobody can see
 * is worse than a refusal.
 *
 * This is a BACKSTOP. The gate that keeps the tool off a turn is `Gateway.runTurn`, which passes
 * `toolsetExclude` per adapter (`CHANNEL_EXCLUDED_TOOLS` / `CANVAS_EXCLUDED_TOOLS`, pinned by
 * `extensions/gateway/src/__tests__/card-post.test.ts`). The check here exists so a surface that
 * slips through degrades into a polite refusal.
 */
export const CARD_PLATFORMS = new Set(['web', 'desktop', 'telegram']);

/**
 * Surfaces that can draw a Canvas (`render_ui`): an interactive sandboxed view, web SPA only.
 * Telegram has no equivalent, so `render_ui` stays off it.
 */
export const CANVAS_PLATFORMS = new Set(['web', 'desktop']);

export function isCardPlatform(platform: string | undefined): boolean {
  return platform !== undefined && CARD_PLATFORMS.has(platform);
}

export function isCanvasPlatform(platform: string | undefined): boolean {
  return platform !== undefined && CANVAS_PLATFORMS.has(platform);
}

/** The one off-surface refusal, shared by `emit_card` and `render_ui`. */
export function offSurfaceRefusal(): ToolResult {
  return {
    ok: false,
    code: 'not_available',
    error: 'Cards render on the web surface; answer in prose here.',
  };
}
