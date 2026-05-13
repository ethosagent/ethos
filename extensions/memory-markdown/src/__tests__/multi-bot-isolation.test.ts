/**
 * Phase 4 — Memory & session isolation verification
 *
 * Verifies the four isolation properties that must hold when multiple bots
 * share a single Ethos process:
 *
 * 1. Different-personality bots write to separate per-personality MEMORY.md files.
 * 2. Same-personality bots (e.g. one human-facing, one programmatic) share memory —
 *    this is expected and documented behaviour.
 * 3. USER.md is always global: it describes the human, not the agent, so every bot
 *    sees it regardless of personality binding.
 * 4. prefetch for each personality returns only that personality's own MEMORY.md
 *    plus the shared USER.md — no cross-contamination.
 *
 * Session-lane isolation (different botKeys → different lane keys → distinct
 * AgentLoop sessions) is already covered in
 * extensions/gateway/src/__tests__/gateway.test.ts ("lanes are isolated across
 * bots even for the same chatId"). It is referenced here, not re-tested.
 */
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

// Minimal session context — matches what AgentLoop passes to the memory provider.
function botCtx(
  botKey: string,
  personalityId: string,
  memoryScope: 'per-personality' | 'global' = 'per-personality',
) {
  return {
    sessionId: `tg:${botKey}:chat42`,
    sessionKey: `tg:${botKey}:chat42`,
    platform: 'telegram',
    personalityId,
    memoryScope,
  } as const;
}

let testDir: string;
let provider: MarkdownFileMemoryProvider;

beforeEach(() => {
  testDir = join(tmpdir(), `ethos-multi-bot-test-${Date.now()}`);
  provider = new MarkdownFileMemoryProvider({ dir: testDir });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 1: different-personality bots → separate MEMORY.md files
// ---------------------------------------------------------------------------

describe('different-personality bots — memory isolation', () => {
  it('each bot writes to its own personality subdirectory', async () => {
    const researcherCtx = botCtx('researcher-bot', 'researcher');
    const coderCtx = botCtx('coder-bot', 'coder');

    await provider.sync(researcherCtx, [
      { store: 'memory', action: 'add', content: 'Researcher insight.' },
    ]);
    await provider.sync(coderCtx, [{ store: 'memory', action: 'add', content: 'Coder insight.' }]);

    const researcherMem = await readFile(
      join(testDir, 'personalities', 'researcher', 'MEMORY.md'),
      'utf-8',
    );
    const coderMem = await readFile(join(testDir, 'personalities', 'coder', 'MEMORY.md'), 'utf-8');

    expect(researcherMem).toContain('Researcher insight.');
    expect(researcherMem).not.toContain('Coder insight.');
    expect(coderMem).toContain('Coder insight.');
    expect(coderMem).not.toContain('Researcher insight.');
  });

  it('shared MEMORY.md at root is not written when both bots use per-personality scope', async () => {
    await provider.sync(botCtx('researcher-bot', 'researcher'), [
      { store: 'memory', action: 'add', content: 'Researcher insight.' },
    ]);
    await provider.sync(botCtx('coder-bot', 'coder'), [
      { store: 'memory', action: 'add', content: 'Coder insight.' },
    ]);

    const shared = await readFile(join(testDir, 'MEMORY.md'), 'utf-8').catch(() => null);
    if (shared !== null) {
      expect(shared).not.toContain('Researcher insight.');
      expect(shared).not.toContain('Coder insight.');
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: same-personality bots → shared memory (documented behaviour)
// ---------------------------------------------------------------------------

describe('same-personality bots — shared memory', () => {
  it('two bots bound to the same personality accumulate into one MEMORY.md', async () => {
    // e.g. one human-facing bot and one programmatic-callers bot, both bound to 'researcher'
    const humanBot = botCtx('researcher-human', 'researcher');
    const apiBot = botCtx('researcher-api', 'researcher');

    await provider.sync(humanBot, [
      { store: 'memory', action: 'add', content: 'Human session fact.' },
    ]);
    await provider.sync(apiBot, [{ store: 'memory', action: 'add', content: 'API session fact.' }]);

    const sharedMem = await readFile(
      join(testDir, 'personalities', 'researcher', 'MEMORY.md'),
      'utf-8',
    );

    expect(sharedMem).toContain('Human session fact.');
    expect(sharedMem).toContain('API session fact.');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: USER.md is always global across all bots
// ---------------------------------------------------------------------------

describe('USER.md — global across bots', () => {
  it('a USER.md write from one bot is visible to a different-personality bot on prefetch', async () => {
    const researcherCtx = botCtx('researcher-bot', 'researcher');
    const coderCtx = botCtx('coder-bot', 'coder');

    // Researcher bot writes user context
    await provider.sync(researcherCtx, [
      { store: 'user', action: 'replace', content: 'I prefer TypeScript.' },
    ]);

    // Coder bot (different personality) reads — should see the USER.md
    const result = await provider.prefetch(coderCtx);

    expect(result).not.toBeNull();
    expect(result?.content).toContain('I prefer TypeScript.');
  });

  it('USER.md file lives at the root, not inside any personality subdirectory', async () => {
    await provider.sync(botCtx('researcher-bot', 'researcher'), [
      { store: 'user', action: 'replace', content: 'Root user fact.' },
    ]);

    const rootUser = await readFile(join(testDir, 'USER.md'), 'utf-8');
    expect(rootUser).toContain('Root user fact.');

    // Must NOT appear inside any personality subdirectory
    const personalityUser = await readFile(
      join(testDir, 'personalities', 'researcher', 'USER.md'),
      'utf-8',
    ).catch(() => null);
    expect(personalityUser).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: prefetch returns own MEMORY.md + shared USER.md, not other's
// ---------------------------------------------------------------------------

describe('prefetch — per-bot memory context', () => {
  it('each bot sees only its personality MEMORY.md on prefetch', async () => {
    await provider.sync(botCtx('researcher-bot', 'researcher'), [
      { store: 'memory', action: 'add', content: 'Researcher-only fact.' },
    ]);
    await provider.sync(botCtx('coder-bot', 'coder'), [
      { store: 'memory', action: 'add', content: 'Coder-only fact.' },
    ]);

    const researcherResult = await provider.prefetch(botCtx('researcher-bot', 'researcher'));
    const coderResult = await provider.prefetch(botCtx('coder-bot', 'coder'));

    expect(researcherResult?.content).toContain('Researcher-only fact.');
    expect(researcherResult?.content).not.toContain('Coder-only fact.');

    expect(coderResult?.content).toContain('Coder-only fact.');
    expect(coderResult?.content).not.toContain('Researcher-only fact.');
  });

  it('prefetch includes shared USER.md for all bots alongside per-personality MEMORY.md', async () => {
    await provider.sync(botCtx('researcher-bot', 'researcher'), [
      { store: 'user', action: 'replace', content: 'I work in fintech.' },
    ]);
    await provider.sync(botCtx('researcher-bot', 'researcher'), [
      { store: 'memory', action: 'add', content: 'Researcher memory.' },
    ]);
    await provider.sync(botCtx('coder-bot', 'coder'), [
      { store: 'memory', action: 'add', content: 'Coder memory.' },
    ]);

    const researcherResult = await provider.prefetch(botCtx('researcher-bot', 'researcher'));
    const coderResult = await provider.prefetch(botCtx('coder-bot', 'coder'));

    // Both bots see the shared USER.md
    expect(researcherResult?.content).toContain('I work in fintech.');
    expect(coderResult?.content).toContain('I work in fintech.');

    // Each bot only sees its own MEMORY.md
    expect(researcherResult?.content).toContain('Researcher memory.');
    expect(researcherResult?.content).not.toContain('Coder memory.');
    expect(coderResult?.content).toContain('Coder memory.');
    expect(coderResult?.content).not.toContain('Researcher memory.');
  });
});
