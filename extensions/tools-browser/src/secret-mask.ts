// ---------------------------------------------------------------------------
// Filled-secret masking chokepoint (plan reach-and-containment D4-6)
// ---------------------------------------------------------------------------
//
// Playwright's aria snapshot renders a textbox's current value, so any browser
// tool that returns a snapshot after `browser_fill_credential` ran would print
// the username / password / TOTP code it just filled. Instead of asking every
// tool to remember, `createBrowserTools` wraps EVERY tool it returns in
// `withSecretMask`, which rewrites the result (and progress events) through
// `maskFilledSecrets` on the way out. A browser tool added later is covered by
// being in the roster; `__tests__/secret-mask.test.ts` iterates the roster and
// fails on one that is not wrapped.
//
// The values live in `BrowserSession.filledSecrets` — process memory only,
// never persisted — and are dropped when the session's resources close
// (`closeSessionResources` in sessions.ts, reached by `closeSession`, the idle
// sweep, relaunch and process exit).

import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { type BrowserSession, sessions } from './sessions';

export const SECRET_MASK = '••••••';

/**
 * Values shorter than this are not registered. Masking a one- or two-letter
 * username would rewrite every occurrence of that letter in every later
 * result, and a value that short gives no secrecy to protect.
 */
export const MIN_MASKED_LENGTH = 4;

const wrapped = new WeakSet<Tool>();

/** True when `tool` came out of `withSecretMask` (the roster test reads this). */
export function isSecretMasked(tool: Tool): boolean {
  return wrapped.has(tool);
}

function sessionsFor(sessionId: string): BrowserSession[] {
  const out: BrowserSession[] = [];
  for (const [key, session] of sessions) {
    if (key === sessionId || key.startsWith(`${sessionId}::`)) out.push(session);
  }
  return out;
}

/** Add filled values to a session's mask set. */
export function registerFilledSecrets(session: BrowserSession, values: readonly string[]): void {
  for (const value of values) {
    if (value.length < MIN_MASKED_LENGTH) continue;
    session.filledSecrets ??= new Set();
    session.filledSecrets.add(value);
  }
}

function maskWith(values: readonly string[], text: string): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(SECRET_MASK);
  }
  return out;
}

function collectValues(sessionId: string): string[] {
  const all = new Set<string>();
  for (const session of sessionsFor(sessionId)) {
    for (const v of session.filledSecrets ?? []) all.add(v);
  }
  // Longest first, so a value that contains another is masked whole.
  return [...all].sort((a, b) => b.length - a.length);
}

/** Replace every value in `sessionId`'s mask set with {@link SECRET_MASK}. */
export function maskFilledSecrets(sessionId: string, text: string): string {
  const values = collectValues(sessionId);
  return values.length === 0 ? text : maskWith(values, text);
}

function maskDeep(values: readonly string[], input: unknown): unknown {
  if (typeof input === 'string') return maskWith(values, input);
  if (Array.isArray(input)) return input.map((v) => maskDeep(values, v));
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = maskDeep(values, v);
    return out;
  }
  return input;
}

function maskResult(sessionId: string, result: ToolResult): ToolResult {
  const values = collectValues(sessionId);
  if (values.length === 0) return result;
  if (result.ok) {
    return {
      ...result,
      value: maskWith(values, result.value),
      ...(result.structured
        ? { structured: maskDeep(values, result.structured) as Record<string, unknown> }
        : {}),
    };
  }
  return { ...result, error: maskWith(values, result.error) };
}

/**
 * Wrap a browser tool so its result, error and progress events are masked.
 * Idempotent — wrapping a wrapped tool returns it unchanged.
 */
export function withSecretMask<T>(tool: Tool<T>): Tool<T> {
  if (wrapped.has(tool as Tool)) return tool;
  const inner = tool.execute.bind(tool);
  const out: Tool<T> = {
    ...tool,
    async execute(args: T, ctx: ToolContext): Promise<ToolResult> {
      const maskedCtx: ToolContext = {
        ...ctx,
        emit: (event) =>
          ctx.emit({ ...event, message: maskFilledSecrets(ctx.sessionId, event.message) }),
      };
      const result = await inner(args, maskedCtx);
      return maskResult(ctx.sessionId, result);
    },
  };
  wrapped.add(out as Tool);
  return out;
}
