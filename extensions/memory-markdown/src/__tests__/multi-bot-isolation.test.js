/**
 * Phase 4 — Memory & session isolation verification
 *
 * Verifies the isolation properties that must hold when multiple bots
 * share a single Ethos process:
 *
 * 1. Different-personality bots write to separate per-personality MEMORY.md files.
 * 2. Same-personality bots (e.g. one human-facing, one programmatic) share memory —
 *    this is expected and documented behaviour.
 * 3. USER.md is scoped per-personality (lives in personality subdirectory). Per-user
 *    profiles use the `user:<userId>` scope prefix (tested in scope-isolation.test.ts).
 * 4. prefetch for each personality returns only that personality's own MEMORY.md
 *    and USER.md — no cross-contamination.
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
function botCtx(botKey, personalityId) {
  return {
    scopeId: `personality:${personalityId}`,
    sessionId: `tg:${botKey}:chat42`,
    sessionKey: `tg:${botKey}:chat42`,
    platform: 'telegram',
    workingDir: '/tmp',
  };
}
let testDir;
let provider;
beforeEach(() => {
  testDir = join(
    tmpdir(),
    `ethos-multi-bot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Researcher insight.' }],
      researcherCtx,
    );
    await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Coder insight.' }], coderCtx);
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
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Researcher insight.' }],
      botCtx('researcher-bot', 'researcher'),
    );
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Coder insight.' }],
      botCtx('coder-bot', 'coder'),
    );
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
    const humanBot = botCtx('researcher-human', 'researcher');
    const apiBot = botCtx('researcher-api', 'researcher');
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Human session fact.' }],
      humanBot,
    );
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'API session fact.' }],
      apiBot,
    );
    const sharedMem = await readFile(
      join(testDir, 'personalities', 'researcher', 'MEMORY.md'),
      'utf-8',
    );
    expect(sharedMem).toContain('Human session fact.');
    expect(sharedMem).toContain('API session fact.');
  });
});
// ---------------------------------------------------------------------------
// Scenario 3: USER.md is scoped per-personality (no longer global)
// ---------------------------------------------------------------------------
describe('USER.md — scoped per personality', () => {
  it('a USER.md write from one bot is NOT visible to a different-personality bot', async () => {
    const researcherCtx = botCtx('researcher-bot', 'researcher');
    const coderCtx = botCtx('coder-bot', 'coder');
    await provider.sync(
      [{ action: 'replace', key: 'USER.md', content: 'I prefer TypeScript.' }],
      researcherCtx,
    );
    const result = await provider.prefetch(coderCtx);
    const all = result?.entries.map((e) => e.content).join('\n') ?? '';
    expect(all).not.toContain('I prefer TypeScript.');
  });
  it('USER.md file lives in the personality subdirectory', async () => {
    await provider.sync(
      [{ action: 'replace', key: 'USER.md', content: 'Per-personality user fact.' }],
      botCtx('researcher-bot', 'researcher'),
    );
    const personalityUser = await readFile(
      join(testDir, 'personalities', 'researcher', 'USER.md'),
      'utf-8',
    );
    expect(personalityUser).toContain('Per-personality user fact.');
    const rootUser = await readFile(join(testDir, 'USER.md'), 'utf-8').catch(() => null);
    expect(rootUser).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// Scenario 4: prefetch returns own MEMORY.md + own USER.md, not other's
// ---------------------------------------------------------------------------
describe('prefetch — per-bot memory context', () => {
  it('each bot sees only its personality MEMORY.md on prefetch', async () => {
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Researcher-only fact.' }],
      botCtx('researcher-bot', 'researcher'),
    );
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Coder-only fact.' }],
      botCtx('coder-bot', 'coder'),
    );
    const researcherResult = await provider.prefetch(botCtx('researcher-bot', 'researcher'));
    const coderResult = await provider.prefetch(botCtx('coder-bot', 'coder'));
    const reviewerMem = researcherResult?.entries.find((e) => e.key === 'MEMORY.md')?.content;
    const coderMem = coderResult?.entries.find((e) => e.key === 'MEMORY.md')?.content;
    expect(reviewerMem).toContain('Researcher-only fact.');
    expect(reviewerMem).not.toContain('Coder-only fact.');
    expect(coderMem).toContain('Coder-only fact.');
    expect(coderMem).not.toContain('Researcher-only fact.');
  });
  it('prefetch includes only that personality own USER.md alongside MEMORY.md', async () => {
    await provider.sync(
      [{ action: 'replace', key: 'USER.md', content: 'I work in fintech.' }],
      botCtx('researcher-bot', 'researcher'),
    );
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Researcher memory.' }],
      botCtx('researcher-bot', 'researcher'),
    );
    await provider.sync(
      [{ action: 'add', key: 'MEMORY.md', content: 'Coder memory.' }],
      botCtx('coder-bot', 'coder'),
    );
    const researcherResult = await provider.prefetch(botCtx('researcher-bot', 'researcher'));
    const coderResult = await provider.prefetch(botCtx('coder-bot', 'coder'));
    const flatten = (r) => r?.entries.map((e) => `${e.key}::${e.content}`).join('\n') ?? '';
    // Researcher sees its own USER.md
    expect(flatten(researcherResult)).toContain('I work in fintech.');
    // Coder does NOT see researcher's USER.md
    expect(flatten(coderResult)).not.toContain('I work in fintech.');
    expect(flatten(researcherResult)).toContain('Researcher memory.');
    expect(flatten(researcherResult)).not.toContain('Coder memory.');
    expect(flatten(coderResult)).toContain('Coder memory.');
    expect(flatten(coderResult)).not.toContain('Researcher memory.');
  });
});
