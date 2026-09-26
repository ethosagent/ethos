// A3 — every error code the agent loop yields has an entry in the one
// chat-error map. The codes are extracted from the core sources themselves
// (agent-loop.ts, agent-loop/stages/*, agent-loop/overflow.ts), so a new
// `yield { type: 'error', code: '...' }` in core fails this test until the
// map covers it.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_ERROR_ACTION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { CHAT_ERROR_MAP, describeChatError } from '../chat-errors';

const CORE_SRC = join(import.meta.dirname, '..', '..', '..', 'core', 'src');

/** `code:` literals on `yield { type: 'error', … }` events. The non-greedy
 *  window stops at the yield's own `code:`; a spread yield (`overflowErrorEvent`)
 *  has none in range and is covered by the overflow.ts scan below. */
const ERROR_YIELD_CODE = /type:\s*'error'[\s\S]{0,400}?code:\s*(?:'([^']+)'|`([^`]+)`)/g;

function errorYieldCodes(source: string): { literals: string[]; templates: string[] } {
  const literals: string[] = [];
  const templates: string[] = [];
  for (const match of source.matchAll(ERROR_YIELD_CODE)) {
    const literal = match[1];
    const template = match[2];
    if (literal) literals.push(literal);
    else if (template) templates.push(template);
  }
  return { literals, templates };
}

function coreErrorSources(): string[] {
  const stagesDir = join(CORE_SRC, 'agent-loop', 'stages');
  const stageFiles = readdirSync(stagesDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(stagesDir, f));
  return [join(CORE_SRC, 'agent-loop.ts'), ...stageFiles];
}

describe('CHAT_ERROR_MAP coverage (A3)', () => {
  const literals = new Set<string>();
  const templates = new Set<string>();
  for (const file of coreErrorSources()) {
    const found = errorYieldCodes(readFileSync(file, 'utf8'));
    for (const code of found.literals) literals.add(code);
    for (const code of found.templates) templates.add(code);
  }
  // `overflowErrorEvent` returns `{ error, code }` that agent-loop.ts spreads
  // into an error yield, so its codes count as yielded codes.
  const overflow = readFileSync(join(CORE_SRC, 'agent-loop', 'overflow.ts'), 'utf8');
  for (const match of overflow.matchAll(/code:\s*'([^']+)'/g)) {
    const code = match[1];
    if (code) literals.add(code);
  }

  it('the extraction still sees the known core codes (regex rot guard)', () => {
    for (const code of [
      'aborted',
      'llm_error',
      'streaming_timeout',
      'model_unresolved',
      'context_overflow',
    ]) {
      expect([...literals]).toContain(code);
    }
    expect(templates.size).toBeGreaterThan(0); // watcher_${halt.rule}
  });

  it('every literal error code yielded by core has a map entry', () => {
    for (const code of literals) {
      const entry = CHAT_ERROR_MAP[code];
      expect(entry, `CHAT_ERROR_MAP is missing '${code}'`).toBeDefined();
      expect(entry?.title).toBeTruthy();
      expect(entry?.action).toBeTruthy();
      expect(typeof entry?.retryable).toBe('boolean');
    }
  });

  it('every template-literal error code resolves by prefix, not the generic fallback', () => {
    for (const template of templates) {
      const prefix = template.split('${')[0] ?? '';
      expect(prefix).toBeTruthy();
      const described = describeChatError(`${prefix}some_rule`, 'raw');
      expect(described.action).not.toBe(FALLBACK_ERROR_ACTION);
    }
  });

  it('the required entries carry their named next steps', () => {
    expect(CHAT_ERROR_MAP.context_overflow?.action).toMatch(/\/compact|\/new/);
    expect(CHAT_ERROR_MAP.model_unresolved?.action).toContain('~/.ethos/config.yaml');
    expect(CHAT_ERROR_MAP.rate_limited?.retryable).toBe(true);
    expect(CHAT_ERROR_MAP.llm_error).toBeDefined();
    expect(CHAT_ERROR_MAP.streaming_timeout).toBeDefined();
    expect(CHAT_ERROR_MAP.aborted).toBeDefined();
  });
});

describe('describeChatError', () => {
  it('returns the map entry for a known code and passes the trace through', () => {
    const described = describeChatError('llm_error', 'raw provider text', 'trace-1');
    expect(described.title).toBe(CHAT_ERROR_MAP.llm_error?.title);
    expect(described.action).toBe(CHAT_ERROR_MAP.llm_error?.action);
    expect(described.retryable).toBe(true);
    expect(described.trace).toBe('trace-1');
  });

  it('falls back to the raw message and the shared fallback action for unknown codes', () => {
    const described = describeChatError('mystery_code', 'the provider said something odd');
    expect(described.title).toBe('the provider said something odd');
    expect(described.action).toBe(FALLBACK_ERROR_ACTION);
    expect(described.retryable).toBe(false);
    expect(described.trace).toBeUndefined();
  });

  it('names the code when the raw message is empty', () => {
    const described = describeChatError('mystery_code', '  ');
    expect(described.title).toBe('error (mystery_code)');
  });
});
