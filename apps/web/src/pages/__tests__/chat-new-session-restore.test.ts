// New Session must land on a fresh chat, not the agent's last session.
//
// Chat strips `?new=1` from the URL once consumed (so Back doesn't replay it),
// which leaves a bare URL the restore effect used to read as "resume" — it then
// redirected to the most recent session. The decision itself is unit-tested as
// `shouldRestoreLastSession` in `lib/__tests__/workspaceScope.test.ts`; this
// file reads `Chat.tsx` and proves Chat is what routes through it with the
// consumed-request ref, since a correct helper nobody calls fixes nothing.
// (Source-reading precedent: `chat-takeover-composer.test.ts`.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(join(import.meta.dirname, '..', 'Chat.tsx'), 'utf8');

describe('Chat restore effect honours a consumed New Session request', () => {
  it('seeds the fresh-request ref from `?new=1` at mount', () => {
    expect(chatSource).toContain('const freshRequested = useRef(newSessionParam !== null);');
  });

  it('gates the restore on shouldRestoreLastSession, passing the ref', () => {
    expect(chatSource).toMatch(
      /!shouldRestoreLastSession\(\{[^}]*freshRequested: freshRequested\.current,[^}]*\}\)/,
    );
  });

  it('sets the ref when consuming `?new=1`, before stripping it from the URL', () => {
    const consumer = chatSource.indexOf('if (!newSessionParam) return;');
    const set = chatSource.indexOf('freshRequested.current = true;', consumer);
    const strip = chatSource.indexOf("next.delete('new');", consumer);
    expect(consumer).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(consumer);
    expect(strip).toBeGreaterThan(set);
  });

  it('clears the ref once a session is in the URL', () => {
    expect(chatSource).toContain('freshRequested.current = false;');
  });
});
