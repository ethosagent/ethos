import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Relative on purpose: the learning inbox is injected into this package through
// `LearningSubmitPort`, but the tests submit through the REAL store.
import {
  type LearningCandidate,
  listCandidates,
  readCandidate,
  submitCandidate,
} from '../../../learning-inbox/src/store';
import { DEFAULT_EVOLVE_CONFIG } from '../analyze';
import { type EvolveOptions, SkillEvolver, skillEvolutionEvolveOptions } from '../evolver';

let testDir: string;
let skillsDir: string;
let evalPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  skillsDir = join(testDir, 'skills');
  evalPath = join(testDir, 'eval.jsonl');
  await mkdir(skillsDir, { recursive: true });
});

/** The options every test shares: a real inbox under the tmp dir, personality `researcher`. */
function base(): Pick<EvolveOptions, 'learning' | 'dataDir' | 'personalityId'> {
  const storage = new FsStorage();
  return {
    dataDir: testDir,
    personalityId: 'researcher',
    learning: {
      submit: (input) => submitCandidate(storage, testDir, input),
      has: async (id) => (await readCandidate(storage, testDir, id)) !== null,
    },
  };
}

async function candidates(): Promise<LearningCandidate[]> {
  return listCandidates(new FsStorage(), testDir);
}

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeLLM(responses: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      const text = responses[i++] ?? '';
      return (async function* () {
        yield { type: 'text_delta', text };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('SkillEvolver', () => {
  it('submits a rewritten skill to the learning inbox as a rewrite of that file (path 7: eval)', async () => {
    await writeFile(join(skillsDir, 'json.md'), 'old content', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `q${i}`,
        },
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `a${i}`,
          score: 0.2,
          skill_files_used: ['json.md'],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM(['<skill>\nrewritten body\n</skill>']);

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.rewritesSubmitted).toEqual(['json.md']);

    const [candidate] = await candidates();
    expect(candidate).toMatchObject({
      id: result.candidateIds[0],
      kind: 'skill',
      op: 'rewrite',
      origin: 'eval',
      personalityId: 'researcher',
      status: 'pending_replay',
      destination: join(skillsDir, 'json.md'),
    });
    expect(candidate?.content).toContain('rewritten body');
    expect(candidate?.content).toContain('target_file: json.md');
    expect(candidate?.baseHash).not.toBeNull();
    // Nothing live changed and no pending queue exists.
    expect(await readFile(join(skillsDir, 'json.md'), 'utf-8')).toBe('old content');
    expect(await readdir(join(skillsDir, 'pending')).catch(() => [])).toEqual([]);
  });

  it('submits a new skill from a high-score zero-skill bundle', async () => {
    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `prompt${i}`,
        },
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `answer${i}`,
          score: 1,
          skill_files_used: [],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM([
      '<filename>map-over-loops.md</filename>\n<skill>\nPrefer map().\n</skill>',
    ]);

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.newSkillsSubmitted).toEqual(['map-over-loops.md']);
    const [candidate] = await candidates();
    expect(candidate).toMatchObject({
      op: 'create',
      destination: join(skillsDir, 'map-over-loops.md'),
    });
    expect(candidate?.content).toContain('Prefer map().');
  });

  it('records skip reason when LLM responds NO_REWRITE', async () => {
    await writeFile(join(skillsDir, 'a.md'), 'x', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push({
        schema_version: '1.0',
        task_id: `t${i}`,
        turn: 0,
        role: 'assistant',
        content: '',
        score: 0,
        skill_files_used: ['a.md'],
      });
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM(['NO_REWRITE']);
    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.rewritesSubmitted).toEqual([]);
    expect(result.skipped).toEqual([{ kind: 'rewrite', target: 'a.md', reason: 'NO_REWRITE' }]);

    expect(await candidates()).toEqual([]);
  });

  it('evolveExisting:false skips the rewrite branch while still creating new skills', async () => {
    // Seed a low-scoring existing skill (rewrite candidate) AND a high-score
    // zero-skill bundle (new-skill candidate) in the same eval output.
    await writeFile(join(skillsDir, 'json.md'), 'old content', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `r${i}`,
          turn: 0,
          role: 'assistant',
          content: `a${i}`,
          score: 0.2,
          skill_files_used: ['json.md'],
        },
        {
          schema_version: '1.0',
          task_id: `n${i}`,
          turn: 0,
          role: 'assistant',
          content: `answer${i}`,
          score: 1,
          skill_files_used: [],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    // Only the new-skill draft should be requested; the rewrite is skipped.
    const llm = makeLLM([
      '<filename>map-over-loops.md</filename>\n<skill>\nPrefer map().\n</skill>',
    ]);

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      evolveExisting: false,
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.rewritesSubmitted).toEqual([]);
    expect(result.newSkillsSubmitted).toEqual(['map-over-loops.md']);
    // The rewrite candidate was identified by analysis but never written.
    expect(result.plan.rewriteCandidates.length).toBeGreaterThan(0);
  });

  it('avoids overwriting an existing skill with a duplicate filename', async () => {
    await writeFile(join(skillsDir, 'shared.md'), 'preexisting', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push({
        schema_version: '1.0',
        task_id: `t${i}`,
        turn: 0,
        role: 'assistant',
        content: '',
        score: 1,
        skill_files_used: [],
      });
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const llm = makeLLM(['<filename>shared.md</filename>\n<skill>\nfresh\n</skill>']);
    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.newSkillsSubmitted).toEqual(['shared-2.md']);
    const original = await readFile(join(skillsDir, 'shared.md'), 'utf-8');
    expect(original).toBe('preexisting');
  });

  // An LLM-authored skill whose frontmatter does not parse is a boot failure
  // waiting to be approved — it must never reach the inbox in the first place.
  const BROKEN_FRONTMATTER = [
    '---',
    'name: stock-add',
    'description: We repeatedly hit the same workflow problem: adding stocks with null sectors',
    '---',
    '',
    'Add stocks carefully.',
  ].join('\n');

  it('does not write a rewrite whose generated frontmatter is unparseable', async () => {
    await writeFile(join(skillsDir, 'json.md'), 'old content', 'utf-8');

    const lines: object[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push({
        schema_version: '1.0',
        task_id: `t${i}`,
        turn: 0,
        role: 'assistant',
        content: '',
        score: 0.2,
        skill_files_used: ['json.md'],
      });
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm: makeLLM([`<skill>\n${BROKEN_FRONTMATTER}\n</skill>`]),
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.rewritesSubmitted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ kind: 'rewrite', target: 'json.md' });
    expect(result.skipped[0]?.reason).toContain('invalid-frontmatter');

    expect(await candidates()).toEqual([]);
  });

  it('does not write a new skill whose generated frontmatter is unparseable', async () => {
    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `prompt${i}`,
        },
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `answer${i}`,
          score: 1,
          skill_files_used: [],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm: makeLLM([`<filename>stock-add.md</filename>\n<skill>\n${BROKEN_FRONTMATTER}\n</skill>`]),
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.newSkillsSubmitted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ kind: 'new', target: 'stock-add.md' });
    expect(result.skipped[0]?.reason).toContain('invalid-frontmatter');

    expect(await candidates()).toEqual([]);
  });

  it('still writes a candidate whose frontmatter quotes the colon', async () => {
    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'user',
          content: `prompt${i}`,
        },
        {
          schema_version: '1.0',
          task_id: `t${i}`,
          turn: 0,
          role: 'assistant',
          content: `answer${i}`,
          score: 1,
          skill_files_used: [],
        },
      );
    }
    await writeFile(evalPath, jsonl(...lines), 'utf-8');

    const good = '---\nname: stock-add\ndescription: "problem: null sectors"\n---\n\nBody.';
    const evolver = new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm: makeLLM([`<filename>stock-add.md</filename>\n<skill>\n${good}\n</skill>`]),
      storage: new FsStorage(),
    });

    const result = await evolver.evolve();
    expect(result.newSkillsSubmitted).toEqual(['stock-add.md']);
    expect(result.skipped).toEqual([]);
  });
});

/** A low-scoring `json.md` (rewrite candidate) and a high-score skill-less bundle (new-skill candidate). */
async function seedRewriteAndNew(): Promise<void> {
  await writeFile(join(skillsDir, 'json.md'), 'old content', 'utf-8');
  const lines: object[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(
      {
        schema_version: '1.0',
        task_id: `r${i}`,
        turn: 0,
        role: 'assistant',
        content: `a${i}`,
        score: 0.2,
        skill_files_used: ['json.md'],
      },
      {
        schema_version: '1.0',
        task_id: `n${i}`,
        turn: 0,
        role: 'assistant',
        content: `answer${i}`,
        score: 1,
        skill_files_used: [],
      },
    );
  }
  await writeFile(evalPath, jsonl(...lines), 'utf-8');
}

describe('SkillEvolver honours skill_evolution.model', () => {
  function recordingLLM() {
    const options: Array<Parameters<LLMProvider['complete']>[2]> = [];
    const responses = [
      '<skill>\nrewritten body\n</skill>',
      '<filename>map-over-loops.md</filename>\n<skill>\nPrefer map().\n</skill>',
    ];
    const llm: LLMProvider = {
      name: 'mock',
      model: 'mock',
      maxContextTokens: 100_000,
      supportsCaching: false,
      supportsThinking: false,
      complete(...args: Parameters<LLMProvider['complete']>): AsyncIterable<CompletionChunk> {
        const text = responses[options.length] ?? '';
        options.push(args[2]);
        return (async function* () {
          yield { type: 'text_delta', text };
          yield { type: 'done', finishReason: 'end_turn' };
        })();
      },
      async countTokens() {
        return 0;
      },
    };
    return { llm, options };
  }

  it('routes the rewrite and the new-skill drafting calls to the model via modelOverride', async () => {
    await seedRewriteAndNew();
    const { llm, options } = recordingLLM();
    const result = await new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      model: 'drafter-model',
      storage: new FsStorage(),
    }).evolve();

    expect(result.rewritesSubmitted).toEqual(['json.md']);
    expect(result.newSkillsSubmitted).toEqual(['map-over-loops.md']);
    expect(options.map((o) => o?.modelOverride)).toEqual(['drafter-model', 'drafter-model']);
  });

  it('leaves modelOverride unset when no model is configured', async () => {
    await seedRewriteAndNew();
    const { llm, options } = recordingLLM();
    await new SkillEvolver({
      evalOutputPath: evalPath,
      skillsDir,
      ...base(),
      config: DEFAULT_EVOLVE_CONFIG,
      llm,
      storage: new FsStorage(),
    }).evolve();

    expect(options).toHaveLength(2);
    expect(options.every((o) => o?.modelOverride === undefined)).toBe(true);
  });
});

describe('skillEvolutionEvolveOptions', () => {
  it('maps scope, evolve_existing and model onto the evolver options', () => {
    expect(
      skillEvolutionEvolveOptions({
        enabled: true,
        scope: 'personality',
        evolve_existing: false,
        model: 'drafter-model',
      }),
    ).toEqual({ scope: 'personality', evolveExisting: false, model: 'drafter-model' });
  });

  it('contributes nothing for absent keys, so the evolver defaults apply', () => {
    expect(skillEvolutionEvolveOptions(undefined)).toEqual({});
    expect(skillEvolutionEvolveOptions({ enabled: true, min_tool_calls: 5 })).toEqual({});
  });
});
