// `skill_evolution.*` reaches the drafters through the command code itself, not
// just through the package functions those commands call:
//   - `ethos nightly`       → `nightlySkillDrafter` (enabled, scope, model)
//   - `ethos evolve`        → `runAnalyze`          (evolve_existing, model)
//   - `ethos eval --evolve` → `runEvolveAfter`      (evolve_existing, model)
// Every draft still lands in the learning inbox as `pending_replay`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { listCandidates } from '@ethosagent/learning-inbox';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  LLMProvider,
  PersonalityConfig,
  PersonalityRegistry,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({}) as { llm?: unknown });

vi.mock('../../wiring', async () => {
  const { FsStorage } = await import('@ethosagent/storage-fs');
  const storage = new FsStorage();
  return {
    createLLM: async () => holder.llm,
    getStorage: () => storage,
    createAgentLoop: vi.fn(),
    createCliLearningInbox: vi.fn(),
    createLearningReplayer: vi.fn(),
  };
});

const { runEvolveAfter } = await import('../eval');
const { runAnalyze } = await import('../evolve');
const { nightlySkillDrafter } = await import('../nightly');
const { FsStorage } = await import('@ethosagent/storage-fs');

type CallOptions = Parameters<LLMProvider['complete']>[2];

const REWRITE = '<skill>\nrewritten body\n</skill>';
const NEW_SKILL = '<filename>map-over-loops.md</filename>\n<skill>\nPrefer map().\n</skill>';

/** Answers a rewrite prompt and a new-skill prompt by recognising the skill under rewrite. */
function recordingLLM() {
  const calls: Array<{ prompt: string; options: CallOptions }> = [];
  const llm: LLMProvider = {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(...args: Parameters<LLMProvider['complete']>): AsyncIterable<CompletionChunk> {
      const [messages, , options] = args;
      const first = messages[0];
      const prompt = typeof first?.content === 'string' ? first.content : '';
      calls.push({ prompt, options });
      const text = prompt.includes('old content') ? REWRITE : NEW_SKILL;
      return (async function* () {
        yield { type: 'text_delta', text };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
  return { llm, calls };
}

describe('nightly skill drafter (ethos nightly)', () => {
  const DATA = '/ethos';
  const evidence = {
    recentPrompts: [],
    evidenceDigest: 'user: how do I parse json\nassistant: use JSON.parse',
    windowStart: '2026-09-12T00:00:00.000Z',
    windowEnd: '2026-09-13T00:00:00.000Z',
    elapsedHours: 24,
  };

  function drafterFor(skillEvolution: PersonalityConfig['skill_evolution']) {
    const personality: PersonalityConfig = {
      id: 'sage',
      name: 'Sage',
      skill_evolution: skillEvolution,
    };
    const reg: Pick<PersonalityRegistry, 'get'> = { get: () => personality };
    const storage = new InMemoryStorage();
    const { llm, calls } = recordingLLM();
    const draft = nightlySkillDrafter({
      reg,
      llm,
      dataDir: DATA,
      learningCtx: { storage, dataDir: DATA, personalities: reg },
      digests: new Map(),
    });
    return { draft, calls, storage };
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enabled: false drafts nothing and makes no LLM call', async () => {
    const { draft, calls, storage } = drafterFor({ enabled: false, model: 'drafter-model' });
    expect(await draft('sage', evidence)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await listCandidates(storage, DATA)).toEqual([]);
  });

  it('enabled absent drafts nothing', async () => {
    const { draft, calls } = drafterFor(undefined);
    expect(await draft('sage', evidence)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('enabled: true submits a candidate, drafted on skill_evolution.model, to skill_evolution.scope', async () => {
    const { draft, calls, storage } = drafterFor({
      enabled: true,
      model: 'drafter-model',
      scope: 'personality',
    });
    expect(await draft('sage', evidence)).toBe(1);
    expect(calls.map((c) => c.options?.modelOverride)).toEqual(['drafter-model']);
    const [candidate] = await listCandidates(storage, DATA);
    expect(candidate).toMatchObject({ origin: 'nightly', status: 'pending_replay' });
    expect(candidate?.destination).toBe(
      join(DATA, 'personalities', 'sage', 'skills', 'nightly-20260913T0000000.md'),
    );
  });
});

describe('eval-driven evolution (ethos evolve / ethos eval --evolve)', () => {
  let dir: string;
  let evalPath: string;
  let skillsDir: string;
  const prevStateDir = process.env.ETHOS_STATE_DIR;

  const config = {
    schemaVersion: 1,
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'sk-test',
    personality: 'researcher',
  } satisfies EthosConfig;

  async function seed(skillEvolutionLines: string[]): Promise<void> {
    const pdir = join(dir, 'personalities', 'researcher');
    await mkdir(pdir, { recursive: true });
    await writeFile(
      join(pdir, 'config.yaml'),
      ['name: Researcher', ...skillEvolutionLines, ''].join('\n'),
    );
    await writeFile(join(pdir, 'SOUL.md'), '# Core\nI research.\n\n# Expression\nPlainly.\n');

    await mkdir(skillsDir, { recursive: true });
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
    await writeFile(evalPath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  }

  const ops = async () => (await listCandidates(new FsStorage(), dir)).map((c) => c.op).sort();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-skill-evolution-keys-'));
    process.env.ETHOS_STATE_DIR = dir;
    evalPath = join(dir, 'run.eval.jsonl');
    skillsDir = join(dir, 'skills');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = prevStateDir;
    await rm(dir, { recursive: true, force: true });
  });

  const entryPoints = [
    {
      name: 'ethos evolve',
      run: () => runAnalyze(evalPath, config, skillsDir, false),
    },
    {
      name: 'ethos eval --evolve',
      run: () => runEvolveAfter(config, evalPath, false, [], new Map()),
    },
  ];

  for (const entry of entryPoints) {
    it(`${entry.name}: evolve_existing: false stops rewrites while new skills still draft`, async () => {
      await seed(['skill_evolution.evolve_existing: false']);
      const { llm, calls } = recordingLLM();
      holder.llm = llm;
      await entry.run();
      expect(calls.some((c) => c.prompt.includes('old content'))).toBe(false);
      expect(await ops()).toEqual(['create']);
    });

    it(`${entry.name}: evolve_existing absent keeps rewrites on`, async () => {
      await seed([]);
      const { llm } = recordingLLM();
      holder.llm = llm;
      await entry.run();
      expect(await ops()).toEqual(['create', 'rewrite']);
    });

    it(`${entry.name}: skill_evolution.model reaches every drafting call`, async () => {
      await seed(['skill_evolution.model: drafter-model']);
      const { llm, calls } = recordingLLM();
      holder.llm = llm;
      await entry.run();
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.options?.modelOverride)).toEqual([
        'drafter-model',
        'drafter-model',
      ]);
    });
  }
});
