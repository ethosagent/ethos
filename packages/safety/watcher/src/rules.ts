// Ch.6a — Built-in watcher rules.
//
// Each rule is a closure over its config. State lives on WatcherState so
// rules don't keep their own per-instance memory (makes them safe to
// instantiate per-session and easy to test).

import type { WatcherRule, WatcherState } from './types';

// ---------------------------------------------------------------------------
// Rate limit — too many tool calls in a sliding window
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** Max tool_end events allowed in `windowMs`. Default 60. */
  max?: number;
  /** Sliding window in milliseconds. Default 60_000 (60s). */
  windowMs?: number;
}

export function rateLimitRule(opts: RateLimitOptions = {}): WatcherRule {
  const max = opts.max ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  return {
    id: 'rate-limit',
    evaluate(event, state) {
      if (event.type !== 'tool_end' || !event.toolName) return null;
      const now = Date.now();
      const all = aggregateRecent(state, now, windowMs);
      all.push(now);
      const tail = all.slice(-max - 1);
      // Track per-tool too so we can name the offender for telemetry, but
      // the cap is a global call rate.
      const list = state.recentToolEnds.get(event.toolName) ?? [];
      list.push(now);
      state.recentToolEnds.set(event.toolName, list);
      pruneAll(state, now, windowMs);

      if (tail.length > max) {
        return {
          action: 'pause',
          rule: 'rate-limit',
          reason: `Tool-call rate exceeded: > ${max} calls in ${Math.round(windowMs / 1000)}s`,
        };
      }
      return null;
    },
    onTurnReset() {
      // Rate limit is intentionally cross-turn — a runaway loop spread across
      // many short turns is exactly the shape we want to catch.
    },
  };
}

function aggregateRecent(state: WatcherState, now: number, windowMs: number): number[] {
  const all: number[] = [];
  for (const list of state.recentToolEnds.values()) {
    for (const t of list) if (t > now - windowMs) all.push(t);
  }
  return all;
}

function pruneAll(state: WatcherState, now: number, windowMs: number): void {
  for (const [name, list] of state.recentToolEnds.entries()) {
    const fresh = list.filter((t) => t > now - windowMs);
    if (fresh.length === 0) state.recentToolEnds.delete(name);
    else state.recentToolEnds.set(name, fresh);
  }
}

// ---------------------------------------------------------------------------
// Token-output budget per turn
// ---------------------------------------------------------------------------

export interface TokenBudgetOptions {
  /** Max output tokens per turn before pausing. Default 50_000. */
  max?: number;
}

export function tokenBudgetRule(opts: TokenBudgetOptions = {}): WatcherRule {
  const max = opts.max ?? 50_000;
  return {
    id: 'token-budget',
    evaluate(event, state) {
      if (event.type !== 'usage' || event.outputTokens === undefined) return null;
      state.outputTokensThisTurn += event.outputTokens;
      if (state.outputTokensThisTurn > max) {
        return {
          action: 'pause',
          rule: 'token-budget',
          reason: `Output token budget exceeded: ${state.outputTokensThisTurn} > ${max} this turn`,
        };
      }
      return null;
    },
    onTurnReset(state) {
      state.outputTokensThisTurn = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Compounding tool errors — N consecutive failures from the same tool
// ---------------------------------------------------------------------------

export interface CompoundingErrorOptions {
  /** Consecutive failures from the same tool before pausing. Default 5. */
  threshold?: number;
}

export function compoundingErrorRule(opts: CompoundingErrorOptions = {}): WatcherRule {
  const threshold = opts.threshold ?? 5;
  return {
    id: 'compounding-error',
    evaluate(event, state) {
      if (event.type !== 'tool_end' || !event.toolName) return null;
      const tool = event.toolName;
      if (event.ok === false) {
        const count = (state.consecutiveFailures.get(tool) ?? 0) + 1;
        state.consecutiveFailures.set(tool, count);
        if (count >= threshold) {
          return {
            action: 'pause',
            rule: 'compounding-error',
            reason: `${tool} failed ${count} times in a row`,
          };
        }
      } else {
        state.consecutiveFailures.delete(tool);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Suspicious tool sequence — read of credential-shaped path → exfil-shaped call
// ---------------------------------------------------------------------------

const CREDENTIAL_PATH_PATTERNS: RegExp[] = [
  /\.ssh\b/,
  /\.aws\/credentials\b/,
  /\.gnupg\b/,
  /\.netrc\b/,
  /\/etc\/(?:passwd|shadow|sudoers)\b/,
  /authorized_keys\b/,
];

/**
 * Registered tools that can carry agent-chosen content to a destination the
 * agent chooses — the second half of a credential exfiltration. The line is
 * the DESTINATION, not "uses the network": a tool that only talks to a fixed
 * provider (`web_search`, `x_search`, `image_generate`, …) cannot deliver a
 * secret to an attacker-run host, while a URL argument, a typed form field, a
 * message, or a peer agent's prompt can.
 *
 *   - URL-taking fetchers: the query string is the carrier.
 *   - Browser text entry: typing into a page is posting to it.
 *   - Messaging, telephony and agent-to-agent sends: the payload IS the send.
 *
 * Pinned against the real tool definitions by
 * packages/wiring/src/__tests__/watcher-exfil-tool-names.test.ts: every name
 * here must be registered by a real factory, and every tool declaring
 * `allowedHosts: ['*']` must be listed here or exempted there with a reason.
 */
export const EXFIL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // URL-taking fetchers (tools-web, tools-browser, tools-vision, tools-meeting)
  'web_extract',
  'browse_url',
  'browser_navigate',
  'browser_computed_style',
  'video_analyze',
  'meet_join',
  // Browser text entry (tools-browser)
  'browser_type',
  'browser_vision_type',
  // Messaging and telephony (tools-messaging, tools-voice)
  'send_message',
  'call',
  // Agent-to-agent: the prompt leaves this process (tools-a2a, tools-delegation)
  'a2a_send',
  'route_to_agent',
  'broadcast_to_agents',
  'dispatch_team',
]);

/**
 * MCP tools are registered as `mcp__<server>__<tool>` (tools-mcp) and cannot
 * be enumerated here: every one is a call into a third-party process with
 * arguments the agent chose, so all of them count.
 */
const MCP_TOOL_PREFIX = 'mcp__';

export function isExfilShapedTool(toolName: string): boolean {
  return EXFIL_TOOL_NAMES.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}

export interface SequenceRuleOptions {
  /** Window in number of recent tool calls. Default 4. */
  window?: number;
}

export function suspiciousSequenceRule(opts: SequenceRuleOptions = {}): WatcherRule {
  const window = opts.window ?? 4;
  return {
    id: 'suspicious-sequence',
    evaluate(event, state) {
      if (event.type === 'tool_start' && event.toolName) {
        const arg = describeArgs(event.args);
        state.recentCalls.push({ name: event.toolName, argSnippet: arg });
        if (state.recentCalls.length > window) state.recentCalls.shift();

        if (isExfilShapedTool(event.toolName)) {
          // Look for a credential-shaped read in the recent window.
          const credRead = state.recentCalls.find(
            (c) =>
              (c.name === 'read_file' || c.name === 'search_files' || c.name === 'terminal') &&
              CREDENTIAL_PATH_PATTERNS.some((re) => re.test(c.argSnippet)),
          );
          if (credRead) {
            return {
              action: 'terminate',
              rule: 'suspicious-sequence',
              reason: `Credential-shaped read by ${credRead.name} → exfil-shaped ${event.toolName}`,
            };
          }
        }
      }
      return null;
    },
  };
}

function describeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string') return a.path.slice(0, 200);
  if (typeof a.url === 'string') return a.url.slice(0, 200);
  if (typeof a.command === 'string') return a.command.slice(0, 200);
  return JSON.stringify(a).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Default rule set
// ---------------------------------------------------------------------------

export function defaultRules(): WatcherRule[] {
  return [rateLimitRule(), tokenBudgetRule(), compoundingErrorRule(), suspiciousSequenceRule()];
}
