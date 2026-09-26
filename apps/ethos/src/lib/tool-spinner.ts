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
