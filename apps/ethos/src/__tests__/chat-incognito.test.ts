// Lane E1 (plan incognito-sessions §8) — `ethos chat --incognito`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  INCOGNITO_ENTRY_LINE,
  INCOGNITO_PROMPT_TAG,
  INCOGNITO_RESUME_REFUSAL,
  INCOGNITO_SCRUB_FAILED_NOTICE,
  incognitoResumeRefusal,
  incognitoSessionKey,
  resumedSessionIsIncognito,
  scrubIncognitoSession,
  scrubWithNotice,
} from '../lib/chat-incognito';

const sessionWith = (metadata: Record<string, unknown>): Session => ({ metadata }) as Session;

describe('--incognito flag forwarding (index.ts)', () => {
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

  it('is parsed once and forwarded in both runChat branches', () => {
    expect(src).toContain("chatArgs.includes('--incognito')");
    const forwards = src.match(/\.\.\.\(incognitoFlag \? \{ incognito: true \} : \{\}\)/g) ?? [];
    expect(forwards).toHaveLength(2);
  });
});

describe('incognitoSessionKey', () => {
  it('matches the /new key format cli:<cwd>:<ts>', () => {
    expect(incognitoSessionKey('/tmp/proj', 1234)).toBe('cli:proj:1234');
  });
});

describe('wording', () => {
  it('uses the plan wording', () => {
    expect(INCOGNITO_PROMPT_TAG).toBe('[incognito]');
    expect(INCOGNITO_ENTRY_LINE).toBe(
      'Incognito: nothing from this session is remembered or learned from. Cleared on /new or after 24 h.',
    );
  });
});

describe('scrubIncognitoSession', () => {
  it('scrubs the given key (used by /new and by -q after the drain)', async () => {
    const scrubIncognito = vi.fn(async () => ({ messages: 2, sessionIds: ['s1'] }));
    await expect(scrubIncognitoSession({ scrubIncognito }, 'cli:proj:1')).resolves.toBe(true);
    expect(scrubIncognito).toHaveBeenCalledWith({ sessionKey: 'cli:proj:1' });
  });

  it('fails open: a throwing scrub or a store without the method is false, not an error', async () => {
    const throwing = {
      scrubIncognito: async () => {
        throw new Error('db locked');
      },
    };
    await expect(scrubIncognitoSession(throwing, 'k')).resolves.toBe(false);
    await expect(scrubIncognitoSession({}, 'k')).resolves.toBe(false);
  });
});

describe('resumedSessionIsIncognito', () => {
  it('reads the sticky stamp from the stored session', async () => {
    const store = (s: Session | null) => ({ getSessionByKey: async () => s });
    await expect(
      resumedSessionIsIncognito(store(sessionWith({ incognito: true })), 'k'),
    ).resolves.toBe(true);
    await expect(resumedSessionIsIncognito(store(sessionWith({})), 'k')).resolves.toBe(false);
    await expect(resumedSessionIsIncognito(store(null), 'k')).resolves.toBe(false);
  });
});

describe('--incognito with --resume / -c', () => {
  const store = (s: Session | null) => ({ getSessionByKey: async () => s });

  it('refuses a normal session, with the plan wording', async () => {
    expect(INCOGNITO_RESUME_REFUSAL).toBe(
      "--incognito starts a new private session; it can't resume a normal one. Drop --resume/-c, or resume without --incognito.",
    );
    await expect(incognitoResumeRefusal(store(sessionWith({})), 'k', true)).resolves.toBe(
      INCOGNITO_RESUME_REFUSAL,
    );
  });

  it('allows an incognito session, with or without the flag, and a normal one without it', async () => {
    const inc = store(sessionWith({ incognito: true }));
    await expect(incognitoResumeRefusal(inc, 'k', true)).resolves.toBeNull();
    await expect(incognitoResumeRefusal(inc, 'k', false)).resolves.toBeNull();
    await expect(incognitoResumeRefusal(store(sessionWith({})), 'k', false)).resolves.toBeNull();
  });

  it('is wired into the resume resolution in index.ts and exits non-zero', () => {
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toMatch(
      /incognitoResumeRefusal\(store, session\.key, incognitoFlag\);\s+if \(refusal\) \{\s+console\.error\(refusal\);\s+process\.exit\(1\);/,
    );
  });
});

describe('scrubWithNotice', () => {
  it('says nothing when the scrub ran', async () => {
    const notify = vi.fn();
    await expect(scrubWithNotice(async () => true, 'k', notify)).resolves.toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('prints the notice when the scrub did not run', async () => {
    const notify = vi.fn();
    await expect(scrubWithNotice(async () => false, 'k', notify)).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith(INCOGNITO_SCRUB_FAILED_NOTICE);
  });

  it('the -q path and /personality use it (chat.ts)', () => {
    const src = readFileSync(join(__dirname, '..', 'commands', 'chat.ts'), 'utf-8');
    // one-shot: dim notice on stderr
    expect(src).toMatch(/scrubWithNotice\(scrubIncognitoKey, oneShotKey,/);
    expect(src).toMatch(/process\.stderr\.write/);
    // /personality scrubs the key it rotates away from
    expect(src).toMatch(/scrubWithNotice\(scrubIncognitoKey, previousKey,/);
  });
});
