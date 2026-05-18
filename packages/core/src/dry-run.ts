import { redactString } from '@ethosagent/safety-redact';
import type { ToolResult } from '@ethosagent/types';

const MAX_STRING_LENGTH = 500;

export function redactArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    const redacted = redactString(args);
    if (redacted.length > MAX_STRING_LENGTH) {
      return `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated, ${redacted.length} chars]`;
    }
    return redacted;
  }
  if (Array.isArray(args)) {
    return args.map(redactArgs);
  }
  if (args !== null && typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = redactArgs(v);
    }
    return out;
  }
  return args;
}

export function synthesizeDryRunResult(toolName: string, args: unknown): ToolResult {
  const redacted = redactArgs(args);
  return {
    ok: true,
    value: `[dry-run] ${toolName} would be called with: ${JSON.stringify(redacted)}`,
  };
}

export function synthesizeDryRunCapResult(_toolName: string, cap: number): ToolResult {
  return {
    ok: false,
    error: `[dry-run] tool call cap (${cap}) reached — stopping tool execution for this turn`,
    code: 'not_available',
  };
}
