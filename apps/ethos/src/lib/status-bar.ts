// FW-1 — persistent status bar for the chat REPL.
//
// Renders model · tokens · context% · duration on a single line, sized to the
// terminal width. Three layouts:
//
//   full     (≥ 76 cols) — model │ used/max │ [█████░░░░░] 50% │ 15m
//   compact  (52–75)    — model │ used/max │ 50% │ 15m
//   minimal  (< 52)     — model │ 15m

const BAR_WIDTH = 10;
const SEP = ' │ ';
const MODEL_TRUNCATE_AT = 26;

export type Threshold = 'green' | 'yellow' | 'orange' | 'red';

export interface StatusBarInput {
  /** Resolved model id; truncated past MODEL_TRUNCATE_AT chars. */
  model: string;
  /** Tokens consumed in the current context window. */
  contextTokens: number;
  /** Max input window for the active model (e.g. 200_000 for Sonnet/Opus). */
  contextMax: number;
  /** Seconds since session start. */
  elapsedSecs: number;
  /** Terminal width in columns — `process.stdout.columns ?? 80`. */
  columns: number;
  /** C4 — active personality id; prefixed to the model as `researcher · <model>`. */
  personality?: string;
  /** C4 — current session key; rendered in the full layout only. */
  sessionKey?: string;
  /** C4 — messages in this session; rendered beside the session key. */
  messageCount?: number;
  /** C4 — session cost in USD; rendered in full and compact layouts. */
  costUsd?: number;
}

export type Layout = 'full' | 'compact' | 'minimal';

export function pickLayout(columns: number): Layout {
  if (columns >= 76) return 'full';
  if (columns >= 52) return 'compact';
  return 'minimal';
}

export function thresholdFor(percent: number): Threshold {
  if (percent >= 95) return 'red';
  if (percent >= 80) return 'orange';
  if (percent >= 50) return 'yellow';
  return 'green';
}

function truncateModel(model: string): string {
  if (model.length <= MODEL_TRUNCATE_AT) return model;
  return `${model.slice(0, MODEL_TRUNCATE_AT - 1)}…`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs}h` : `${hrs}h${rem}m`;
}

/**
 * C4 — the one cost formatter for the status bar, `/usage` and `/budget`:
 * two decimals, four when below one cent (JSON surfaces keep full precision).
 */
export function formatCostUsd(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2);
}

function buildBar(percent: number): string {
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((percent / 100) * BAR_WIDTH)));
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`;
}

export interface RenderedStatusBar {
  layout: Layout;
  /** Plain text — no ANSI. The REPL wraps the bar segment with threshold colors. */
  text: string;
  /** Width of `text` in display columns. */
  columns: number;
  /** Threshold for the context-bar color signal (the segment between SEPs). */
  threshold: Threshold;
}

export function renderStatusBar(input: StatusBarInput): RenderedStatusBar {
  const percent =
    input.contextMax > 0 ? Math.min(100, (input.contextTokens / input.contextMax) * 100) : 0;
  const threshold = thresholdFor(percent);
  const layout = pickLayout(input.columns);
  const model = truncateModel(input.model);
  const duration = formatDuration(input.elapsedSecs);
  // C4 — personality and model form one identity segment; cost drops out at
  // minimal, session at compact and minimal (the layout-tier rule the file
  // already follows for the bar and the token counts).
  const label = input.personality ? `${input.personality} · ${model}` : model;
  const cost = input.costUsd !== undefined ? `${SEP}$${formatCostUsd(input.costUsd)}` : '';
  const session =
    input.sessionKey !== undefined
      ? `${SEP}${input.sessionKey}${input.messageCount !== undefined ? ` (${input.messageCount} msgs)` : ''}`
      : '';

  let text: string;
  if (layout === 'minimal') {
    text = `${label}${SEP}${duration}`;
  } else if (layout === 'compact') {
    const tokens = `${formatTokens(input.contextTokens)}/${formatTokens(input.contextMax)}`;
    text = `${label}${SEP}${tokens}${SEP}${Math.round(percent)}%${cost}${SEP}${duration}`;
  } else {
    const tokens = `${formatTokens(input.contextTokens)}/${formatTokens(input.contextMax)}`;
    const bar = buildBar(percent);
    text = `${label}${SEP}${tokens}${SEP}${bar} ${Math.round(percent)}%${cost}${SEP}${duration}${session}`;
  }

  return { layout, text, columns: text.length, threshold };
}
