import type { RowData } from '../lib/row';

// A failed RPC is a resolved row naming the cause (§11) — never a toast. The
// server's FORBIDDEN already names the scope (`API key is missing required
// scope "kanban:read"`, apps/web-api/src/middleware/dual-auth.ts), so the row
// quotes it; nothing else on the screen breaks.

export const SCOPE_HINT = 'Create a key with this scope on the web';

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

export function isUnauthorized(err: unknown): boolean {
  return codeOf(err) === 'UNAUTHORIZED';
}

export function errorRow(err: unknown, subject: string): RowData {
  const message = err instanceof Error ? err.message : String(err);
  const code = codeOf(err);
  if (code === 'UNAUTHORIZED') {
    return { glyph: '✗', word: 'key', subject: 'invalid or revoked', result: 'reconnect' };
  }
  const scope = code === 'FORBIDDEN' ? /missing required scope "([^"]+)"/.exec(message)?.[1] : null;
  if (scope) {
    return {
      glyph: '✗',
      word: 'scope',
      subject,
      result: `API key is missing required scope "${scope}" · ${SCOPE_HINT}`,
    };
  }
  return { glyph: '✗', word: 'failed', subject, result: message };
}
