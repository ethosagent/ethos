import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
// Relative on purpose: the learning inbox is injected into this package through
// `LearningSubmitPort`, but the test submits through the REAL store.
import { listCandidates, readCandidate, submitCandidate } from '../../../learning-inbox/src/store';
import type { LearningSubmitPort } from '../learning-port';
import { proposeSkillFromEvidence } from '../nightly-propose';

const WINDOW = '2026-06-17T00:00:00.000Z';
const DATA_DIR = '/data';
const PID = 'sage';
const CANDIDATE = 'nightly-20260617T0000000.md';

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

let storage: InMemoryStorage;
let learning: LearningSubmitPort;

beforeEach(() => {
  storage = new InMemoryStorage();
  learning = {
    submit: (input) => submitCandidate(storage, DATA_DIR, input),
    has: async (id) => (await readCandidate(storage, DATA_DIR, id)) !== null,
  };
});

function input(
  llm: LLMProvider,
  extra: Partial<Parameters<typeof proposeSkillFromEvidence>[0]> = {},
) {
  return {
    personalityId: PID,
    evidenceDigest: 'user: hi\nassistant: hello',
    windowEnd: WINDOW,
    dataDir: DATA_DIR,
    llm,
    learning,
    ...extra,
  };
}

describe('proposeSkillFromEvidence (L-T6, path 2: nightly)', () => {
  it('submits a nightly-origin candidate and writes no pending or live file', async () => {
    const { llm } = makeLLM(GOOD_DRAFT);
    const result = await proposeSkillFromEvidence(
      input(llm, { evidenceSessionIds: ['s-1'], targetCaseIds: ['case-1'] }),
    );

    expect(result.decision).toBe('submitted');
    expect(result.fileName).toBe(CANDIDATE);
    const candidates = await listCandidates(storage, DATA_DIR);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: result.candidateId,
      kind: 'skill',
      op: 'create',
      origin: 'nightly',
      personalityId: PID,
      status: 'pending_replay',
      destination: join(DATA_DIR, 'skills', CANDIDATE),
      content: 'When asked to X, do Y.\n',
      targetCaseIds: ['case-1'],
      evidence: { sessionIds: ['s-1'], ref: `nightly:${WINDOW}` },
    });
    expect(await storage.exists(join(DATA_DIR, 'skills', '.pending'))).toBe(false);
    expect(await storage.exists(join(DATA_DIR, 'skills', CANDIDATE))).toBe(false);
  });

  it("scope='personality' resolves the destination under personalities/<id>/skills/", async () => {
    const { llm } = makeLLM(GOOD_DRAFT);
    await proposeSkillFromEvidence(input(llm, { scope: 'personality' }));
    const [candidate] = await listCandidates(storage, DATA_DIR);
    expect(candidate?.destination).toBe(join(DATA_DIR, 'personalities', PID, 'skills', CANDIDATE));
  });

  it('LLM declines (NO_PATTERN): nothing submitted', async () => {
    const { llm } = makeLLM('NO_PATTERN');
    const result = await proposeSkillFromEvidence(input(llm));
    expect(result.decision).toBe('none');
    expect(result.candidateId).toBeNull();
    expect(await listCandidates(storage, DATA_DIR)).toEqual([]);
  });

  it('idempotency: a second run for the same window drafts nothing and submits nothing new', async () => {
    const { llm, calls } = makeLLM(GOOD_DRAFT);
    const first = await proposeSkillFromEvidence(input(llm));
    const second = await proposeSkillFromEvidence(input(llm));

    expect(second.decision).toBe('exists');
    expect(second.candidateId).toBe(first.candidateId);
    expect(calls()).toBe(1);
    expect(await listCandidates(storage, DATA_DIR)).toHaveLength(1);
  });
});
