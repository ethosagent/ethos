// The CLI chat's decision line (plan decision-provider-personality §15.6): one
// compact line per SETTLED decision, glyph + word always, e.g.
//
//   ✓ decided jev router · trivial 0.91 · 41 ms
//   ✓ observed jev injection · clean · agreed · 36 ms vs 1.4s
//   ⚠ observed jev injection · flagged · LLM said clean · 29 ms vs 1.3s
//   ✗ unavailable jev injection · timeout → LLM check
//
// Pure — `projectEvent` (verbosity.ts) gates it by level and `chat.ts` paints
// it (the decision hue maps to the terminal's cyan). The web trail draws the
// same states from `apps/web/src/lib/trail.ts` `decisionRowView`.

import type { AgentEvent } from '@ethosagent/core';

type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

/**
 * Provider id → the short tag a line names it by. The web keeps the same pair
 * in `apps/web/src/lib/decision-providers.ts`; an unknown id prints as itself.
 */
const PROVIDER_TAGS: Record<string, string> = { typesafe: 'jev' };

/** What each site falls back to when the decision model does not decide. */
const TODAY_PATH: Record<DecisionEvent['site'], string> = {
  injection: 'LLM check',
  approver: 'LLM review',
  router: 'default model',
};

export type DecisionLineTone = 'ok' | 'warning' | 'failed' | 'neutral';

export interface DecisionLine {
  tone: DecisionLineTone;
  /** `✓ decided`, `⚠ observed`, `✗ unavailable` … */
  state: string;
  /** `jev` */
  tag: string;
  /** Everything after the tag: `injection · clean · agreed · 36 ms vs 1.4s`. */
  rest: string;
}

/** Decision latencies read `41 ms` / `1.4s`, as in the web trail. */
export function formatDecisionMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The line for a settled decision event; `null` for a `started` one. */
export function decisionLine(e: DecisionEvent): DecisionLine | null {
  if (e.phase !== 'settled') return null;
  const tag = PROVIDER_TAGS[e.provider] ?? e.provider;
  const fallback = e.mode === 'on' ? ` → ${TODAY_PATH[e.site]}` : '';
  const conf = e.confidence !== undefined ? e.confidence.toFixed(2) : undefined;
  let duration = e.latencyMs !== undefined ? formatDecisionMs(e.latencyMs) : undefined;
  if (duration !== undefined && e.mode === 'shadow' && e.todayLatencyMs !== undefined) {
    duration = `${duration} vs ${formatDecisionMs(e.todayLatencyMs)}`;
  }
  const join = (parts: (string | undefined)[]): string =>
    parts.filter((p): p is string => p !== undefined && p !== '').join(' · ');

  // PD19: the breaker refused without sending a request.
  if (e.outcome === 'breaker_open') {
    return {
      tone: 'failed',
      state: '✗ skipped',
      tag,
      rest: join([e.site, 'paused after repeated failures']),
    };
  }
  if (e.outcome !== undefined && e.outcome !== 'ok') {
    return {
      tone: 'failed',
      state: '✗ unavailable',
      tag,
      rest: `${join([e.site, e.outcome])}${fallback}`,
    };
  }
  if (e.mode === 'on') {
    // `trivial 0.91` — the verdict with its confidence, or the confidence alone.
    const reading = e.verdict !== undefined && conf ? `${e.verdict} ${conf}` : (e.verdict ?? conf);
    if (e.acted === true) {
      return { tone: 'ok', state: '✓ decided', tag, rest: join([e.site, reading, duration]) };
    }
    return {
      tone: 'warning',
      state: '⚠ unsure',
      tag,
      rest: `${join([e.site, reading, duration])}${fallback}`,
    };
  }
  const today = e.site === 'router' ? 'default' : 'LLM';
  if (e.disagreed === true) {
    const said = e.todayVerdict !== undefined ? `${today} said ${e.todayVerdict}` : 'disagreed';
    return {
      tone: 'warning',
      state: '⚠ observed',
      tag,
      rest: join([e.site, e.verdict, said, duration]),
    };
  }
  if (e.disagreed === false) {
    return {
      tone: 'ok',
      state: '✓ observed',
      tag,
      rest: join([e.site, e.verdict, 'agreed', duration]),
    };
  }
  // No comparison (today's path threw): neither agreed nor disagreed.
  return { tone: 'neutral', state: '· observed', tag, rest: join([e.site, e.verdict, duration]) };
}

/** The line as plain text — what `projectEvent` returns. */
export function decisionLineText(line: DecisionLine): string {
  return `${line.state} ${line.tag} ${line.rest}`;
}
