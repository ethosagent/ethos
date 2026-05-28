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
export function pickLayout(columns) {
  if (columns >= 76) return 'full';
  if (columns >= 52) return 'compact';
  return 'minimal';
}
export function thresholdFor(percent) {
  if (percent >= 95) return 'red';
  if (percent >= 80) return 'orange';
  if (percent >= 50) return 'yellow';
  return 'green';
}
function truncateModel(model) {
  if (model.length <= MODEL_TRUNCATE_AT) return model;
  return `${model.slice(0, MODEL_TRUNCATE_AT - 1)}…`;
}
function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
function formatDuration(secs) {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs}h` : `${hrs}h${rem}m`;
}
function buildBar(percent) {
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((percent / 100) * BAR_WIDTH)));
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`;
}
export function renderStatusBar(input) {
  const percent =
    input.contextMax > 0 ? Math.min(100, (input.contextTokens / input.contextMax) * 100) : 0;
  const threshold = thresholdFor(percent);
  const layout = pickLayout(input.columns);
  const model = truncateModel(input.model);
  const duration = formatDuration(input.elapsedSecs);
  let text;
  if (layout === 'minimal') {
    text = `${model}${SEP}${duration}`;
  } else if (layout === 'compact') {
    const tokens = `${formatTokens(input.contextTokens)}/${formatTokens(input.contextMax)}`;
    text = `${model}${SEP}${tokens}${SEP}${Math.round(percent)}%${SEP}${duration}`;
  } else {
    const tokens = `${formatTokens(input.contextTokens)}/${formatTokens(input.contextMax)}`;
    const bar = buildBar(percent);
    text = `${model}${SEP}${tokens}${SEP}${bar} ${Math.round(percent)}%${SEP}${duration}`;
  }
  return { layout, text, columns: text.length, threshold };
}
