// The CLI context readouts use the loop's resolved model window, not a fixed
// 200K. Source-reading test (precedent: apps/web chat-takeover-composer.test.ts):
// chat.ts is a REPL entry that cannot be rendered under vitest.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const chat = src('commands/chat.ts');
const sessions = src('commands/sessions.ts');
const wiring = src('wiring.ts');

describe('CLI context window', () => {
  it('chat.ts has no fixed 200K window', () => {
    expect(chat).not.toContain('DEFAULT_CONTEXT_MAX');
    expect(chat).not.toContain('200_000');
  });

  it('the status bar reads the state window, refreshed on /model', () => {
    expect(chat).toContain('contextMax: state.contextMax');
    expect(chat).toContain('state.contextMax = next.runtime.contextWindow');
  });

  it('/compact status and sessions show share one formatter', () => {
    expect(chat).toContain('formatContextAnatomy(');
    expect(sessions).toContain('formatContextAnatomy(');
  });

  it('wiring carries the resolved window onto ActiveLoop', () => {
    expect(wiring).toContain('contextWindow: result.contextWindow');
    expect(wiring).toContain('contextWindow: teamResult.contextWindow');
  });
});
