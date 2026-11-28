// Plan skill-history-and-lock, C2: `SkillEvolver` skips a rewrite of a locked skill
// (advisory; the guarantee is `SkillHistory.writeAgentAuthored`). Kept beside, not
// inside, `evolver.test.ts`, which is at its size baseline.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listCandidates, readCandidate, submitCandidate } from '../../../learning-inbox/src/store';
import { DEFAULT_EVOLVE_CONFIG } from '../analyze';
import { SkillEvolver } from '../evolver';

let testDir: string;
let skillsDir: string;
let evalPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evolver-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  skillsDir = join(testDir, 'skills');
  evalPath = join(testDir, 'eval.jsonl');
  await mkdir(skillsDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

it('skips a rewrite of a locked skill with reason locked, before asking the LLM', async () => {
  await writeFile(join(skillsDir, 'json.md'), 'old content', 'utf-8');
  const lines = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({
      schema_version: '1.0',
      task_id: `r${i}`,
      turn: 0,
      role: 'assistant',
      content: `a${i}`,
      score: 0.2,
      skill_files_used: ['json.md'],
    }),
  );
  await writeFile(evalPath, `${lines.join('\n')}\n`, 'utf-8');

  let asked = 0;
  const llm: LLMProvider = {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(): AsyncIterable<CompletionChunk> {
      asked++;
      return (async function* () {
        yield { type: 'text_delta', text: '<skill>\nnever asked\n</skill>' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
  const storage = new FsStorage();

  const result = await new SkillEvolver({
    evalOutputPath: evalPath,
    skillsDir,
    config: DEFAULT_EVOLVE_CONFIG,
    llm,
    storage,
    dataDir: testDir,
    personalityId: 'researcher',
    learning: {
      submit: (input) => submitCandidate(storage, testDir, input),
      has: async (id) => (await readCandidate(storage, testDir, id)) !== null,
      isLocked: async (dest) => dest === join(testDir, 'skills', 'json.md'),
    },
  }).evolve();

  expect(result.rewritesSubmitted).toEqual([]);
  expect(result.skipped).toContainEqual({ kind: 'rewrite', target: 'json.md', reason: 'locked' });
  expect(asked).toBe(0);
  expect(await listCandidates(storage, testDir)).toEqual([]);
});
