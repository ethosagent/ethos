import { LEARNING_EXCLUDED_KEY_PREFIXES } from '@ethosagent/learning-inbox';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEvidenceDigest, gatherRecentUserPrompts } from '../personality-evolve';

/**
 * L-D12 — the evidence the Judge and the Expression drafter read must not
 * contain turns Ethos itself drove. `EvalRunner` writes the Judge's own
 * replays to `sessions.db` under `eval:<pid>:<promptId>`, so before this
 * filter the next night's evidence was built from the previous night's
 * output; Parts 2 and 3 added `mcp:`, `outbox-review:` and `replay:` rows to
 * the same table.
 */

const PID = 'researcher';

const baseSession = {
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  personalityId: PID,
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

describe('learning evidence excludes machine-driven sessions', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  async function seed(key: string, text: string): Promise<void> {
    const s = await store.createSession({ ...baseSession, key });
    await store.appendMessage({ sessionId: s.id, role: 'user', content: text });
    await store.appendMessage({ sessionId: s.id, role: 'assistant', content: `re: ${text}` });
  }

  // One case per prefix, so a prefix removed from the list fails here and not
  // only in the learning-inbox package's own capture test.
  it.each([...LEARNING_EXCLUDED_KEY_PREFIXES])(
    'a %s session reaches neither gatherRecentUserPrompts nor buildEvidenceDigest',
    async (prefix) => {
      await seed('cli:project', 'a real user asked this');
      await seed(`${prefix}whatever`, 'machine-driven turn');

      const recent = await gatherRecentUserPrompts(store, PID);
      expect(recent.prompts.map((p) => p.prompt)).toEqual(['a real user asked this']);

      const { digest } = await buildEvidenceDigest(store, PID);
      expect(digest).toContain('a real user asked this');
      expect(digest).not.toContain('machine-driven turn');
    },
  );

  it('still reads ordinary cli: and channel sessions', async () => {
    await seed('cli:project', 'from the terminal');
    await seed('telegram:-100123', 'from telegram');

    const recent = await gatherRecentUserPrompts(store, PID);
    expect(recent.prompts.map((p) => p.prompt).sort()).toEqual([
      'from telegram',
      'from the terminal',
    ]);

    const { digest, hasSessions } = await buildEvidenceDigest(store, PID);
    expect(hasSessions).toBe(true);
    expect(digest).toContain('from the terminal');
    expect(digest).toContain('from telegram');
  });

  // The all-personality fallback is the worse contamination case, not a
  // lesser one: it fires exactly when a personality has no sessions of its
  // own, which is when a night of replays is the only thing in the table.
  it('excludes them from the all-personality fallback too', async () => {
    await seed('eval:someone-else:p1', 'a replay of another personality');

    const recent = await gatherRecentUserPrompts(store, 'nobody-has-run-me');
    expect(recent.prompts).toEqual([]);
    expect(await buildEvidenceDigest(store, 'nobody-has-run-me')).toEqual({
      digest: '',
      hasSessions: false,
      messageIds: [],
      sessionIds: [],
      userTurns: [],
    });
  });

  // X-D7: one list, imported rather than copied. If this import ever has to
  // become a duplicate, the copy needs a parity test — this is the pin that
  // says it is not a duplicate today.
  it('reads the one shared prefix list, not a local copy', () => {
    expect(LEARNING_EXCLUDED_KEY_PREFIXES).toContain('eval:');
    expect(LEARNING_EXCLUDED_KEY_PREFIXES).toContain('replay:');
    expect(LEARNING_EXCLUDED_KEY_PREFIXES).toContain('mcp:');
    expect(LEARNING_EXCLUDED_KEY_PREFIXES).toContain('outbox-review:');
  });
});
