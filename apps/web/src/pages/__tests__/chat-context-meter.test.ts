// Chat wires the context meter and routes /compact through the hook's runCompact.
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
  it('disables Compact now while a turn runs, a takeover holds the session, or it compacts', () => {
    expect(chat).toContain('compactDisabled={turnBusy || takeoverActive || meter.compacting}');
  });

  it('calls compact with no focus argument from the button, via the hook', () => {
    expect(chat).toContain('onCompact={() => void meter.runCompact()}');
    expect(chat).not.toMatch(/void meter\.runCompact\([^)\s]/);
  });

  it('hands compact and the notifier to the hook, so toast and meter refresh stay together', () => {
    expect(chat).toMatch(/useContextAnatomy\(currentSessionId, \{[^}]*\bcompact,\s*notification/);
    expect(chat).not.toContain('notifyCompactResult');
  });

  it('routes the /compact command through the hook', () => {
    expect(chat).toContain('await meter.runCompact(focus || undefined)');
  });

  it('points /compact status at the context ring', () => {
    expect(chat).toContain('Click the context ring beside the composer');
  });
});
