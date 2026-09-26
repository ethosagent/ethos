// C1 (plan ux-feedback-and-config-clarity §4) — per-tool live spinner block.
//
// Between `tool_start` and `tool_end` the REPL keeps one live line per running
// tool on screen:
//
//   ⠹ ┊ bash · make test · 12.4s
//
// The glyph follows the SpinnerState conventions (braille cycle, static `·`
// under ETHOS_NO_SPINNER_ANIMATION / reduced motion); the middle is
// `formatToolFeedLine`, the same formatter the finished `✓ ┊ …` feed line
// uses. Parallel tools render one line each, redrawn as a block, capped at
// MAX_TOOL_SPINNER_LINES with a `+N more` tail (§9 noise cap). Quiet renders
// nothing. Pinned by __tests__/chat-tool-spinner.test.ts.

import { SPINNER_FRAMES } from './spinner';
import { formatToolFeedLine } from './tool-feed';
import type { Verbosity } from './verbosity';

/** §9 — cap on parallel live tool lines; further tools collapse to `+N more`. */
export const MAX_TOOL_SPINNER_LINES = 4;

const STATIC_GLYPH = '·';

interface ActiveTool {
  toolName: string;
  args: unknown;
  startedAt: number;
}

export interface ToolLiveBlockOptions {
  /** Substitute a static `·` for the cycling glyph. Default false. */
  reducedMotion?: boolean;
  /** `tool_preview_length` — forwarded to `formatToolFeedLine`. */
  previewLength?: number;
}

/**
 * Pure state for the live tool block — no I/O. The REPL drives `tick()` from
 * its spinner interval and repaints `linesFor()` as the last lines on screen.
 */
export class ToolLiveBlock {
  private readonly active = new Map<string, ActiveTool>();
  private frameIdx = 0;
  private readonly reducedMotion: boolean;
  private readonly previewLength: number;

  constructor(options: ToolLiveBlockOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.previewLength = options.previewLength ?? 0;
  }

  start(toolCallId: string, toolName: string, args: unknown, now: number): void {
    this.active.set(toolCallId, { toolName, args, startedAt: now });
  }

  end(toolCallId: string): void {
    this.active.delete(toolCallId);
  }

  /** True when a tool with this name is currently running — how a
   *  `tool_progress` (which carries no toolCallId) finds its live line. */
  has(toolName: string): boolean {
    for (const tool of this.active.values()) {
      if (tool.toolName === toolName) return true;
    }
    return false;
  }

  count(): number {
    return this.active.size;
  }

  tick(): void {
    this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
  }

  frame(): string {
    if (this.reducedMotion) return STATIC_GLYPH;
    return SPINNER_FRAMES[this.frameIdx] ?? SPINNER_FRAMES[0];
  }

  /** The block's lines at `now` — `[]` at quiet or when nothing is running. */
  linesFor(verbosity: Verbosity, now: number): string[] {
    if (verbosity === 'quiet') return [];
    const tools = [...this.active.values()];
    const shown = tools.slice(0, MAX_TOOL_SPINNER_LINES);
    const lines = shown.map(
      (tool) =>
        `${this.frame()} ${formatToolFeedLine({
          toolName: tool.toolName,
          args: tool.args,
          durationMs: now - tool.startedAt,
          previewLength: this.previewLength,
        })}`,
    );
    if (tools.length > MAX_TOOL_SPINNER_LINES) {
      lines.push(`  +${tools.length - MAX_TOOL_SPINNER_LINES} more`);
    }
    return lines;
  }
}

/**
 * C1 — after a `tool_end`, the thinking spinner restarts only while the turn
 * still owes its first text and no other tool is running.
 */
export function shouldRestartThinkingSpinner(opts: {
  textStarted: boolean;
  activeToolCount: number;
}): boolean {
  return !opts.textStarted && opts.activeToolCount === 0;
}

/** What the REPL's per-turn repaint interval may do on one tick. */
export type RepaintTick = 'spinner' | 'block' | 'none';

/**
 * The one decision the C1 repaint interval makes each tick, extracted so the
 * two gates it must honour are pinned (chat-tool-spinner.test.ts):
 *
 * - `tty: false` → 'none', always. A pipe gets static feed lines only —
 *   in-place erases/redraws are cursor-escape junk in a log file.
 * - `promptOpen: true` → 'none', always. While the clarify presenter or the
 *   approval prompt owns the input line, a repaint would erase the very line
 *   the user is typing their answer on.
 *
 * Otherwise the original precedence: the thinking spinner while it runs, the
 * live tool block while tools run.
 */
export function repaintTickAction(opts: {
  tty: boolean;
  promptOpen: boolean;
  quiet: boolean;
  spinnerCleared: boolean;
  drawnBlockLines: number;
  activeToolCount: number;
}): RepaintTick {
  if (!opts.tty || opts.promptOpen) return 'none';
  if (!opts.spinnerCleared && !opts.quiet) return 'spinner';
  if (opts.drawnBlockLines > 0 || opts.activeToolCount > 0) return 'block';
  return 'none';
}

/**
 * Events whose one-line notice prints while the thinking spinner's line may
 * still be open, so the REPL must clear it first — otherwise the notice glues
 * onto the spinner text. `text_delta` / `tool_start` / `error` / `decision`
 * already have inline clears in runTurn; these are the ones that did not:
 * `halt` and the loop/watcher `_loop` / `_watcher` `tool_progress` notices.
 */
export function noticeClearsSpinner(event: { type: string; toolName?: string }): boolean {
  if (event.type === 'halt') return true;
  return (
    event.type === 'tool_progress' && (event.toolName === '_loop' || event.toolName === '_watcher')
  );
}
