// `/rewind [N]` in Chat.handleSend. Source-reading (precedent:
// chat-takeover-composer.test.ts) because Chat is too heavy to mount; the
// pick logic itself is unit-tested as `rewindPromptAt` in lib/__tests__.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(import.meta.dirname, '..', 'Chat.tsx'), 'utf8');
const start = src.indexOf('const handleSend = async');
const handleSend = src.slice(start, src.indexOf('const handleGoalQuickStart'));

describe('Chat /rewind', () => {
  it('handles /rewind before the steer branch', () => {
    const rewind = handleSend.indexOf('/rewind');
    expect(rewind).toBeGreaterThan(-1);
    expect(rewind).toBeLessThan(handleSend.indexOf('steerMessage'));
  });

  it('refuses while streaming with REWIND_BUSY, and reports a bad N with the parser message', () => {
    expect(handleSend).toContain('REWIND_BUSY');
    expect(handleSend).toContain('parseRewindArg');
    expect(handleSend).toContain('parsed.message');
    expect(handleSend).toContain('Nothing to rewind yet.');
  });

  it('opens the editor and reruns through rewindTo', () => {
    expect(handleSend).toContain('setEditingMessageId');
    expect(src).toContain('await rewindTo(');
    expect(src).toContain('sessionKeys.list()');
  });

  it('offers Edit & rerun only when idle and not in takeover', () => {
    expect(src).toContain('!state.isStreaming && !takeoverActive');
  });

  it('refuses /rewind during a takeover, and closes the open editor when the edit gate closes', () => {
    expect(handleSend).toContain('Finish the takeover first');
    const effect = src.indexOf(
      'if (state.isStreaming || takeoverActive) setEditingMessageId(null)',
    );
    expect(effect).toBeGreaterThan(-1);
    expect(src.slice(effect, effect + 120)).toContain('[state.isStreaming, takeoverActive]');
  });
});
