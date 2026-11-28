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

/**
 * The surface a turn draws on. `platform` on a `ToolContext` or `PromptContext` is the LOOP's
 * wiring profile ('cli' for a gateway process, 'web' for a merged boot), the same for every turn
 * the loop serves, so it cannot name a channel. A channel turn carries `origin`
 * (`<platform>:<chatId>`, stamped by `Gateway.runTurn`); a web or CLI run carries none and falls
 * back to the profile. Pinned by `__tests__/emit-card.test.ts` and `__tests__/ui-guidance-injector.test.ts`.
 */
export function surfaceOf(ctx: { platform?: string; origin?: string }): string | undefined {
  const channel = ctx.origin?.split(':', 1)[0];
  return channel ? channel : ctx.platform;
}

export function isCardPlatform(surface: string | undefined): boolean {
  return surface !== undefined && CARD_PLATFORMS.has(surface);
}

export function isCanvasPlatform(surface: string | undefined): boolean {
  return surface !== undefined && CANVAS_PLATFORMS.has(surface);
}

/** The one off-surface refusal, shared by `emit_card` and `render_ui`. */
export function offSurfaceRefusal(): ToolResult {
  return {
    ok: false,
    code: 'not_available',
    error: 'Cards render on the web surface; answer in prose here.',
  };
}
