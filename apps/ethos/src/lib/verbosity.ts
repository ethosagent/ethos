// FW-10 — verbose levels for the chat surface.
//
// Four discrete levels modulate what `renderEvent()` emits. The audience
// boundary (Phase 30.2) is the gate at `default`: tools tag a progress event
// `audience: 'user'` to opt-in. `verbose` lifts the gate so internal
// `audience: 'internal'` events surface too. `debug` adds raw JSON.

import { type AgentEvent, describeDeviation, haltNotice } from '@ethosagent/core';
import { answerSuffix } from '@ethosagent/types';
import { decisionLine, decisionLineText } from './decision-line';

export type Verbosity = 'quiet' | 'default' | 'verbose' | 'debug';

export const VERBOSITY_LEVELS: readonly Verbosity[] = ['quiet', 'default', 'verbose', 'debug'];

const CYCLE: readonly Verbosity[] = ['default', 'verbose', 'debug', 'quiet'];

export function isVerbosity(v: string): v is Verbosity {
  return (VERBOSITY_LEVELS as readonly string[]).includes(v);
}

/**
 * `/verbose` (no arg) cycles through `default → verbose → debug → quiet → default`.
 * Any unknown current level falls back to `default` so the cycle re-anchors.
 */
export function nextVerbosity(current: Verbosity): Verbosity {
  const idx = CYCLE.indexOf(current);
  const next = CYCLE[(idx + 1) % CYCLE.length];
  return next ?? 'default';
}

export interface RenderedLine {
  /** Plain text — no ANSI codes — to allow assertions on content. */
  text: string;
  /** Tag for tests + UI styling hints. */
  kind:
    | 'text'
    | 'tool_start'
    | 'tool_progress'
    | 'tool_end'
    | 'usage'
    | 'error'
    | 'debug'
    | 'run_start'
    | 'decision'
    | 'halt';
}

/**
 * What a `done` event still owes after the text that streamed this turn — the
 * answer, after a blank line when a preamble streamed — or `undefined`.
 *
 * A `returnDirect` tool result reaches the turn only as `done.text`, possibly
 * after a preamble the model streamed before the call; in every other turn
 * `done.text` IS the streamed text and nothing is owed. The rule is
 * `answerSuffix` in @ethosagent/types; this is the CLI's one entry to it, for
 * both chat paths (the REPL's `projectEvent` and the single-query runner in
 * commands/chat.ts). Pinned by `__tests__/verbosity-render.test.ts`.
 */
export function unstreamedDoneText(event: AgentEvent, streamedText: string): string | undefined {
  if (event.type !== 'done') return undefined;
  return answerSuffix(streamedText, event.text) || undefined;
}

/**
 * Pure event-to-line(s) projection. Used by tests; the live REPL renders with
 * ANSI directly but consults the same level/audience rules.
 *
 * `turn.streamedText` — every `text_delta` this turn has streamed so far —
 * lets a `done` surface the answer it alone carries (`unstreamedDoneText`).
 * Absent → `done` surfaces nothing, as before.
 *
 * Returns [] for events filtered out at the current level.
 */
export function projectEvent(
  event: AgentEvent,
  verbosity: Verbosity,
  turn?: {
    streamedText: string;
    /** A2 — true when the turn's abort controller fired (the user pressed
     *  Esc / typed /stop). The loop's trailing `error(code: 'aborted')` then
     *  renders nothing; a non-user abort still renders. */
    aborted?: boolean;
  },
): RenderedLine[] {
  const doneAnswer = turn ? unstreamedDoneText(event, turn.streamedText) : undefined;
  // S4/U1 — a budget halt renders at EVERY verbosity, `quiet` included, for
  // the D17 reason: the turn stopped short, and the person reading the reply
  // needs the cap and the reset command in front of them. The wording is
  // `haltNotice`'s (@ethosagent/core), never restated here.
  if (event.type === 'halt') {
    const notice = haltNotice(event);
    const lines: RenderedLine[] = notice ? [{ text: notice, kind: 'halt' }] : [];
    if (verbosity === 'debug') {
      lines.push({ text: `[debug] ${JSON.stringify(event)}`, kind: 'debug' });
    }
    return lines;
  }
  if (verbosity === 'quiet') {
    // Only final assistant text surfaces — plus, per D17, a `run_start`
    // carrying a deviation. This is the one line of that contract: the moment a
    // person needs to know the turn is not running on what was declared is the
    // moment the answer is in front of them, and `quiet` is where somebody
    // reading a reply actually is.
    if (event.type === 'run_start' && event.deviation) {
      const { line, fix } = describeDeviation(event.deviation);
      return [{ text: fix ? `${line} ${fix}` : line, kind: 'run_start' }];
    }
    if (event.type === 'text_delta') return [{ text: event.text, kind: 'text' }];
    if (doneAnswer) return [{ text: doneAnswer, kind: 'text' }];
    return [];
  }

  const out: RenderedLine[] = [];

  switch (event.type) {
    case 'text_delta':
      out.push({ text: event.text, kind: 'text' });
      break;
    case 'tool_start':
      // Lane E (tools-as-code-api) — in-script inner calls are tagged
      // `audience: 'internal'`; `default` hides them, `verbose`+ lifts the
      // gate (same rule as tool_progress below).
      if (verbosity === 'default' && event.audience === 'internal') break;
      out.push({ text: `⟳ ${event.toolName}`, kind: 'tool_start' });
      break;
    case 'tool_progress': {
      // Phase 30.2 — `default` honours the audience gate; `verbose`+ lifts it.
      const isUserOptIn = event.audience === 'user';
      if (verbosity === 'default' && !isUserOptIn) break;
      // A4 — loop-level notices (compact-and-retry, provider fallback) carry
      // the reserved name `_loop` (a `_`-prefixed name no tool may register).
      // One line, message only — the renderer styles it as a yellow notice,
      // never a tool row. Quiet already returned above, so quiet prints none.
      if (event.toolName === '_loop') {
        out.push({ text: event.message, kind: 'tool_progress' });
        break;
      }
      // A budget stop arrives as this user-audience `_budget` chip AND the
      // `halt` right behind it (`budgetGuardEvents`, @ethosagent/core); the
      // halt line above carries the message, so the chip is not repeated.
      if (event.toolName === '_budget' && isUserOptIn) break;
      out.push({
        text: `· ${event.toolName}: ${event.message}`,
        kind: 'tool_progress',
      });
      break;
    }
    case 'tool_end':
      // Lane E — internal inner-call ends stay hidden at `default` even on
      // failure: an inner error is data the script handles, not a turn
      // failure. Non-internal failures keep the Phase 30.2 always-render rule.
      if (verbosity === 'default' && event.audience === 'internal') break;
      out.push({
        text: `${event.ok ? '✓' : '✗'} ${event.toolName} ${event.durationMs}ms`,
        kind: 'tool_end',
      });
      break;
    case 'usage':
      out.push({
        text: `${event.inputTokens} in · ${event.outputTokens} out`,
        kind: 'usage',
      });
      break;
    case 'error':
      // A2 — a user-initiated stop already confirmed itself; the loop's
      // trailing `aborted` error would re-announce it as a failure.
      if (event.code === 'aborted' && turn?.aborted) break;
      out.push({ text: `[${event.code}] ${event.error}`, kind: 'error' });
      break;
    case 'run_start': {
      // D17 — a `run_start` carrying a deviation renders at EVERY verbosity,
      // `quiet` included; the plain "ran on X" line keeps its verbose-only
      // gate. The sentence is `describeDeviation`'s, never restated here.
      const deviation = event.deviation;
      if (deviation) {
        const { line, fix } = describeDeviation(deviation);
        out.push({ text: fix ? `${line} ${fix}` : line, kind: 'run_start' });
      }
      if (verbosity === 'verbose' || verbosity === 'debug') {
        out.push({
          text: `↳ ${event.provider}/${event.model} (${event.source})`,
          kind: 'run_start',
        });
      }
      break;
    }
    case 'done':
      // Only the answer `done` alone carries (see `unstreamedDoneText`); the
      // turn summary is rendered inline in the REPL.
      if (doneAnswer) out.push({ text: doneAnswer, kind: 'text' });
      break;
    case 'thinking_delta':
    case 'context_meta':
      // Not surfaced at any verbosity in the line projection; `context_meta` is
      // internal.
      break;
    case 'decision': {
      // plan decision-provider-personality §15.6 — one line per SETTLED
      // decision, gated like `tool_end`: shown from `default` up, hidden in
      // `quiet` (returned above). A `started` has no line: the CLI has no
      // reserved status slot to put "checking" in.
      const line = decisionLine(event);
      if (line) out.push({ text: decisionLineText(line), kind: 'decision' });
      break;
    }
  }

  if (verbosity === 'debug') {
    out.push({ text: `[debug] ${JSON.stringify(event)}`, kind: 'debug' });
  }

  return out;
}

/** A5 (UD6) — cap for the rolling one-line thinking preview. */
export const THINKING_PREVIEW_MAX = 80;

/**
 * A5 (UD6) — fold a `thinking_delta` into the rolling one-line preview shown
 * at `verbose` and `debug` only: the latest ~80 chars, whitespace flattened so
 * it stays a single line the REPL overwrites in place. Returns `null` at
 * `quiet` and `default` — nothing is shown there.
 */
export function thinkingPreview(
  previous: string,
  delta: string,
  verbosity: Verbosity,
  max = THINKING_PREVIEW_MAX,
): string | null {
  if (verbosity !== 'verbose' && verbosity !== 'debug') return null;
  const merged = (previous + delta).replace(/\s+/g, ' ');
  return merged.length > max ? merged.slice(-max) : merged;
}

export interface VerbosityCommandResult {
  /** The level in effect after the command — unchanged when refused. */
  level: Verbosity;
  /** The line the REPL prints (dim normally, red when refused). */
  notice: string;
  /** C6 — an unknown level is refused and the current level KEPT. */
  refused: boolean;
}

/**
 * C6 — the `/verbose` command's whole decision: no arg cycles, `status`
 * reports, a valid level sets, and anything else is refused with the valid
 * set named — the current level stays in effect.
 */
export function applyVerbosityCommand(arg: string, current: Verbosity): VerbosityCommandResult {
  if (!arg) {
    const next = nextVerbosity(current);
    return { level: next, notice: `verbosity: ${next}`, refused: false };
  }
  if (arg === 'status') return { level: current, notice: `verbosity: ${current}`, refused: false };
  if (isVerbosity(arg)) return { level: arg, notice: `verbosity: ${arg}`, refused: false };
  return {
    level: current,
    notice: `✗ unknown level '${arg}' · valid: quiet|default|verbose|debug`,
    refused: true,
  };
}
