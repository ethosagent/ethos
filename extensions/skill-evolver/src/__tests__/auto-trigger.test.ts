import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSkillEvolutionAutoTrigger, resetSkillEvolutionCooldowns } from '../auto-trigger';

const makeRegistry = (overrides: Partial<PersonalityConfig> = {}) => {
  const personality: PersonalityConfig = {
    id: 'engineer',
    name: 'Engineer',
    skill_evolution: { enabled: true, min_tool_calls: 5, cooldown_minutes: 60 },
    ...overrides,
  };
  return {
    define: () => {},
    get: (_id: string) => personality,
    list: () => [personality],
    getDefault: () => personality,
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
};

let dataDir: string;

beforeEach(async () => {
  resetSkillEvolutionCooldowns();
  dataDir = join(
    tmpdir(),
    `ethos-evolver-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function listAutoCandidates(personalityId: string): Promise<string[]> {
  const dir = join(dataDir, 'skills', '.pending', personalityId);
  try {
    const { readdir } = await import('node:fs/promises');
    return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

describe('SkillEvolutionAutoTrigger (E3)', () => {
  it('queues a candidate when threshold is met', async () => {
    const hooks = new DefaultHookRegistry();
    registerSkillEvolutionAutoTrigger({ hooks, personalities: makeRegistry(), dataDir });
    await hooks.fireVoid('agent_done', {
      sessionId: 'sess1',
      text: 'Done.',
      turnCount: 3,
      personalityId: 'engineer',
      successfulToolCalls: 6,
      totalToolCalls: 6,
      toolNames: ['read_file', 'write_file', 'patch_file'],
      initialPrompt: 'Refactor the auth module.',
    });
    const files = await listAutoCandidates('engineer');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^auto-/);
  });

  it('does NOT queue when below threshold', async () => {
    const hooks = new DefaultHookRegistry();
    registerSkillEvolutionAutoTrigger({ hooks, personalities: makeRegistry(), dataDir });
    await hooks.fireVoid('agent_done', {
      sessionId: 'sess1',
      text: 'Done.',
      turnCount: 1,
      personalityId: 'engineer',
      successfulToolCalls: 2,
      totalToolCalls: 2,
      toolNames: ['read_file'],
    });
    expect(await listAutoCandidates('engineer')).toEqual([]);
  });

  it('does NOT queue when personality has skill_evolution disabled', async () => {
    const hooks = new DefaultHookRegistry();
    registerSkillEvolutionAutoTrigger({
      hooks,
      personalities: makeRegistry({ skill_evolution: { enabled: false } }),
      dataDir,
    });
    await hooks.fireVoid('agent_done', {
      sessionId: 'sess1',
      text: 'Done.',
      turnCount: 5,
      personalityId: 'engineer',
      successfulToolCalls: 10,
      totalToolCalls: 10,
      toolNames: ['read_file'],
    });
    expect(await listAutoCandidates('engineer')).toEqual([]);
  });

  it('respects cooldown — second fire within window does not queue', async () => {
    const hooks = new DefaultHookRegistry();
    let now = 1_000_000_000_000;
    registerSkillEvolutionAutoTrigger({
      hooks,
      personalities: makeRegistry(),
      dataDir,
      now: () => now,
    });
    const payload = {
      sessionId: 'sess1',
      text: 'Done.',
      turnCount: 3,
      personalityId: 'engineer',
      successfulToolCalls: 6,
      totalToolCalls: 6,
      toolNames: ['read_file'],
    };
    await hooks.fireVoid('agent_done', payload);
    expect(await listAutoCandidates('engineer')).toHaveLength(1);
    // 30 minutes later — still inside the 60-minute default cooldown
    now += 30 * 60_000;
    await hooks.fireVoid('agent_done', payload);
    expect(await listAutoCandidates('engineer')).toHaveLength(1);
  });

  it('queues again after cooldown expires', async () => {
    const hooks = new DefaultHookRegistry();
    let now = 1_000_000_000_000;
    registerSkillEvolutionAutoTrigger({
      hooks,
      personalities: makeRegistry(),
      dataDir,
      now: () => now,
    });
    const payload = {
      sessionId: 'sess1',
      text: 'Done.',
      turnCount: 3,
      personalityId: 'engineer',
      successfulToolCalls: 6,
      totalToolCalls: 6,
      toolNames: ['read_file'],
    };
    await hooks.fireVoid('agent_done', payload);
    now += 61 * 60_000;
    await hooks.fireVoid('agent_done', payload);
    expect(await listAutoCandidates('engineer')).toHaveLength(2);
  });

  it('candidate is personality-scoped — each personality gets its own subdir', async () => {
    const hooks = new DefaultHookRegistry();
    const engineer: PersonalityConfig = {
      id: 'engineer',
      name: 'Engineer',
      skill_evolution: { enabled: true, min_tool_calls: 5 },
    };
    const coach: PersonalityConfig = {
      id: 'coach',
      name: 'Coach',
      skill_evolution: { enabled: true, min_tool_calls: 5 },
    };
    const personalities = {
      define: () => {},
      get: (id: string) => (id === 'coach' ? coach : engineer),
      list: () => [engineer, coach],
      getDefault: () => engineer,
      setDefault: () => {},
      loadFromDirectory: async () => {},
      remove: () => {},
    };
    registerSkillEvolutionAutoTrigger({ hooks, personalities, dataDir });
    await hooks.fireVoid('agent_done', {
      sessionId: 'sess1',
      text: 'engineer done',
      turnCount: 3,
      personalityId: 'engineer',
      successfulToolCalls: 6,
      totalToolCalls: 6,
    });
    await hooks.fireVoid('agent_done', {
      sessionId: 'sess2',
      text: 'coach done',
      turnCount: 3,
      personalityId: 'coach',
      successfulToolCalls: 6,
      totalToolCalls: 6,
    });
    expect(await listAutoCandidates('engineer')).toHaveLength(1);
    expect(await listAutoCandidates('coach')).toHaveLength(1);
  });

  it('candidate frontmatter includes auto_proposed provenance', async () => {
    const hooks = new DefaultHookRegistry();
    registerSkillEvolutionAutoTrigger({ hooks, personalities: makeRegistry(), dataDir });
    await hooks.fireVoid('agent_done', {
      sessionId: 'session-abc',
      text: 'Complete.',
      turnCount: 4,
      personalityId: 'engineer',
      successfulToolCalls: 6,
      totalToolCalls: 6,
      toolNames: ['read_file'],
      initialPrompt: 'Refactor X',
    });
    const files = await listAutoCandidates('engineer');
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(
      join(dataDir, 'skills', '.pending', 'engineer', files[0] ?? ''),
      'utf-8',
    );
    expect(body).toContain('auto_proposed: true');
    expect(body).toContain('source_session: "session-abc"');
    expect(body).toContain('source_personality: engineer');
  });
});
