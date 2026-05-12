// FW-11 — tool feed formatter for the chat REPL.
//
// One line per executed tool call:
//
//   ┊ tool_name · key_arg · duration
//
// `key_arg` is the most informative single field from `args`: for `terminal`
// it's the command, for `read_file` it's the path, etc. When `args` doesn't
// match a known shape, we pretty-print the first scalar field. Truncated to
// `tool_preview_length` chars (0 = no limit).

const GLYPH = '┊';
const SEP = ' · ';

export interface ToolFeedLineInput {
  toolName: string;
  args: unknown;
  durationMs: number;
  /** Max characters of `key_arg` to surface. 0 = no truncation. */
  previewLength?: number;
}

/**
 * Format `args` into a one-line preview suitable for the tool feed.
 *
 * Heuristics applied in order:
 *   1. `args` is a string → use directly
 *   2. `args` is an object with a single scalar field → use that field's value
 *   3. `args` is an object with a known "primary" field (cmd, command,
 *      query, q, path, url) → use it
 *   4. `args` is an object → first scalar field
 *   5. otherwise → JSON.stringify
 */
export function previewArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  if (typeof args === 'number' || typeof args === 'boolean') return String(args);
  if (typeof args !== 'object') return JSON.stringify(args);

  const obj = args as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return '';
  const PRIMARY = ['cmd', 'command', 'query', 'q', 'path', 'file', 'url', 'pattern', 'text'];

  for (const key of PRIMARY) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }

  for (const [, v] of Object.entries(obj)) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }

  return JSON.stringify(obj);
}

export function truncatePreview(s: string, max: number): string {
  if (max <= 0) return s;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatToolFeedLine(input: ToolFeedLineInput): string {
  const preview = truncatePreview(previewArgs(input.args), input.previewLength ?? 0);
  const duration = formatDuration(input.durationMs);
  const parts = [input.toolName];
  if (preview) parts.push(preview);
  parts.push(duration);
  return `${GLYPH} ${parts.join(SEP)}`;
}
