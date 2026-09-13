// `skill_evolution.evolve_existing: false` reaches the chat-turn `skill_propose`
// (built in `composeAllTools`, `packages/wiring/src/compose-tools.ts`) exactly as
// it reaches the post-turn fork's (`ImprovementFork.run`): a `targetFile`
// rewrite is refused, a new skill is still accepted.
//
// Driven through the real composition root, offline: HOME and ETHOS_STATE_DIR
// point at a temp dir, the provider baseUrl is a closed port (no LLM call is
// made — the tool is executed directly), and the runtime is disposed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCandidates } from '@ethosagent/learning-inbox';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Tool, ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

const NO_REWRITES = 'no-rewrites';
const REWRITES = 'rewrites';

let home: string;
let dataDir: string;
let runtime: Awaited<ReturnType<typeof createAgentLoop>>;
let skillPropose: Tool;
const prevEnv: Record<string, string | undefined> = {};

function seedPersonality(id: string, skillEvolutionLines: string[]): void {
  const dir = join(dataDir, 'personalities', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), [`name: ${id}`, ...skillEvolutionLines, ''].join('\n'));
  writeFileSync(join(dir, 'SOUL.md'), '# Core\nI draft skills.\n\n# Expression\nPlainly.\n');
  writeFileSync(join(dir, 'toolset.yaml'), '- skill_propose\n');
}

function ctx(personalityId: string): ToolContext {
  return {
    sessionId: 'no-such-session',
    sessionKey: 'cli:chat-skill-propose',
    platform: 'cli',
    personalityId,
    workingDir: home,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  } as ToolContext;
}

async function candidatesFor(personalityId: string) {
  return (await listCandidates(new FsStorage(), dataDir)).filter(
    (c) => c.personalityId === personalityId,
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ethos-chat-skill-propose-'));
  dataDir = join(home, '.ethos');
  mkdirSync(dataDir, { recursive: true });
  seedPersonality(NO_REWRITES, ['skill_evolution.evolve_existing: false']);
  seedPersonality(REWRITES, []);
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;

  const config: WiringConfig = {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    personality: NO_REWRITES,
    memory: 'markdown',
  };
  runtime = await createAgentLoop(config, {
    dataDir,
    workingDir: home,
    disableDocker: true,
    profile: 'cli',
  });
  const tool = runtime.toolRegistry.get('skill_propose');
  if (!tool) throw new Error('skill_propose not registered');
  skillPropose = tool;
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('chat-turn skill_propose honours skill_evolution.evolve_existing', () => {
  it('evolve_existing: false refuses a targetFile rewrite and submits nothing', async () => {
    const result = await skillPropose.execute(
      { content: '# body', reason: 'because', targetFile: 'json.md' },
      ctx(NO_REWRITES),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    expect(await candidatesFor(NO_REWRITES)).toEqual([]);
  });

  it('evolve_existing: false still accepts a new skill', async () => {
    const result = await skillPropose.execute(
      { content: '# body', reason: 'because' },
      ctx(NO_REWRITES),
    );
    expect(result.ok).toBe(true);
    expect((await candidatesFor(NO_REWRITES)).map((c) => c.op)).toEqual(['create']);
  });

  it('evolve_existing absent allows a rewrite', async () => {
    const result = await skillPropose.execute(
      { content: '# body', reason: 'because', targetFile: 'json.md' },
      ctx(REWRITES),
    );
    expect(result.ok).toBe(true);
    expect((await candidatesFor(REWRITES)).map((c) => c.op)).toEqual(['rewrite']);
  });
});
