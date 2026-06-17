import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { proposeSkillFromEvidence } from '../nightly-propose';

const WINDOW = '2026-06-17T00:00:00.000Z';
const DATA_DIR = '/data';
const PID = 'sage';

const CANDIDATE = 'nightly-20260617T0000000.md';
const pendingPath = join(DATA_DIR, 'skills', '.pending', PID, CANDIDATE);
const livePath = join(DATA_DIR, 'skills', CANDIDATE);

function makeLLM(response: string): { llm: LLMProvider; calls: () => number } {
  let calls = 0;
  const llm: LLMProvider = {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      calls++;
      return (async function* () {
        yield { type: 'text_delta', text: response };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
  return { llm, calls: () => calls };
}

const GOOD_DRAFT =
  '<filename>research-pattern.md</filename>\n<skill>When asked to X, do Y.</skill>';

describe('proposeSkillFromEvidence', () => {
  it('manual mode (unset): drafts and queues to pending, never promotes', async () => {
    const storage = new InMemoryStorage();
    const { llm } = makeLLM(GOOD_DRAFT);

    const result = await proposeSkillFromEvidence({
      personalityId: PID,
      approvalMode: undefined,
      evidenceDigest: 'user: how do I research?\nassistant: step 1...',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
    });

    expect(result.decision).toBe('queued');
    expect(result.fileName).toBe(CANDIDATE);
    expect(await storage.read(pendingPath)).toContain('When asked to X, do Y.');
    expect(await storage.read(livePath)).toBeNull();
  });

  it('manual mode (user): queues to pending, never promotes', async () => {
    const storage = new InMemoryStorage();
    const { llm } = makeLLM(GOOD_DRAFT);

    const result = await proposeSkillFromEvidence({
      personalityId: PID,
      approvalMode: 'user',
      evidenceDigest: 'digest',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
    });

    expect(result.decision).toBe('queued');
    expect(await storage.read(pendingPath)).not.toBeNull();
    expect(await storage.read(livePath)).toBeNull();
  });

  it('auto mode + validate PASS: promotes to live skills dir', async () => {
    const storage = new InMemoryStorage();
    const { llm } = makeLLM(GOOD_DRAFT);

    const result = await proposeSkillFromEvidence({
      personalityId: PID,
      approvalMode: 'auto',
      evidenceDigest: 'digest',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
      validate: async () => true,
    });

    expect(result.decision).toBe('promoted');
    expect(await storage.read(livePath)).toContain('When asked to X, do Y.');
    expect(await storage.read(pendingPath)).toBeNull();
  });

  it('auto mode + validate FAIL: stays in pending', async () => {
    const storage = new InMemoryStorage();
    const { llm } = makeLLM(GOOD_DRAFT);

    const result = await proposeSkillFromEvidence({
      personalityId: PID,
      approvalMode: 'auto',
      evidenceDigest: 'digest',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
      validate: async () => false,
    });

    expect(result.decision).toBe('rejected');
    expect(await storage.read(pendingPath)).toContain('When asked to X, do Y.');
    expect(await storage.read(livePath)).toBeNull();
  });

  it('LLM declines (NO_PATTERN): no candidate written', async () => {
    const storage = new InMemoryStorage();
    const { llm } = makeLLM('NO_PATTERN');

    const result = await proposeSkillFromEvidence({
      personalityId: PID,
      approvalMode: 'user',
      evidenceDigest: 'digest',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
    });

    expect(result.decision).toBe('none');
    expect(result.fileName).toBeNull();
    expect(await storage.read(pendingPath)).toBeNull();
  });

  it('idempotency: a second manual run for the same window does not re-draft', async () => {
    const storage = new InMemoryStorage();
    const { llm, calls } = makeLLM(GOOD_DRAFT);

    const input = {
      personalityId: PID,
      approvalMode: 'user' as const,
      evidenceDigest: 'digest',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
    };

    await proposeSkillFromEvidence(input);
    expect(calls()).toBe(1);

    const second = await proposeSkillFromEvidence(input);
    expect(second.decision).toBe('queued');
    expect(second.reason).toContain('already queued');
    // No second LLM draft call.
    expect(calls()).toBe(1);
  });

  it('idempotency: a re-run after promotion does not re-promote or re-draft', async () => {
    const storage = new InMemoryStorage();
    const { llm, calls } = makeLLM(GOOD_DRAFT);

    const input = {
      personalityId: PID,
      approvalMode: 'auto' as const,
      evidenceDigest: 'digest',
      windowEnd: WINDOW,
      dataDir: DATA_DIR,
      storage,
      llm,
      validate: async () => true,
    };

    const first = await proposeSkillFromEvidence(input);
    expect(first.decision).toBe('promoted');
    expect(calls()).toBe(1);

    const second = await proposeSkillFromEvidence(input);
    expect(second.decision).toBe('promoted');
    expect(second.reason).toContain('already promoted');
    expect(calls()).toBe(1);
  });
});
