// Chat wires the context meter and routes /compact through the shared toast.
//
// Read from source: Chat needs a router, query client, SSE stream and voice
// call to render. Precedent: `chat-voice-clarify-refusal.test.ts`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Source with `//` and block comments blanked, so prose cannot pass an assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const chat = stripComments(readFileSync(join(import.meta.dirname, '..', 'Chat.tsx'), 'utf8'));

describe('Chat context meter wiring', () => {
  it('disables Compact now while a turn runs or a takeover holds the session', () => {
    expect(chat).toContain('compactDisabled={turnBusy || takeoverActive}');
  });

  it('calls compact with no focus argument from the button, then toasts and refreshes', () => {
    expect(chat).toContain('compact().then(');
    expect(chat).not.toMatch(/compact\([^)\s][^)]*\)\.then\(/);
    expect(chat).toContain('notifyCompactResult(notification, r)');
    expect(chat).toContain('meter.afterCompact(r)');
  });

  it('routes the /compact command through notifyCompactResult', () => {
    expect(chat).toContain('notifyCompactResult(notification, await compact(focus || undefined))');
  });

  it('points /compact status at the context ring', () => {
    expect(chat).toContain('Click the context ring beside the composer');
  });
});
