import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillsInjector } from '../skills-injector';
import { UniversalScanner } from '../universal-scanner';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-skills-room-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const makeCtx = (extra: Record<string, unknown> = {}) => ({
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  model: 'claude-opus-4-7',
  history: [],
  workingDir: testDir,
  isDm: false,
  turnNumber: 1,
  personalityId: 'researcher',
  ...extra,
});

const registry = (mode: 'full' | 'index' | undefined) => {
  const p = {
    id: 'researcher',
    name: 'Researcher',
    skillsDirs: [testDir],
    ...(mode ? { skills: { injection_mode: mode } } : {}),
  };
  return {
    define: () => {},
    get: () => p,
    list: () => [],
    getDefault: () => p,
    setDefault: () => {},
    loadFromDirectory: async () => {},
    remove: () => {},
  };
};

async function writeSkill(name: string, body = `BODY OF ${name}.`) {
  const dir = join(testDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: desc of ${name}`, '---', body].join('\n'),
  );
}

function make(mode: 'full' | 'index' | undefined, maxInjectionChars?: number) {
  const skipped: Array<[string, string]> = [];
  const injector = new SkillsInjector(registry(mode), {
    storage: new FsStorage(),
    globalSkillsDir: testDir,
    scanner: new UniversalScanner({ storage: new FsStorage(), sources: [] }),
    onSkip: (id, reason) => skipped.push([id, reason]),
    ...(maxInjectionChars !== undefined ? { maxInjectionChars } : {}),
  });
  return { injector, skipped };
}

describe('SkillsInjector — roomSkills', () => {
  it('index mode: pinned skill renders full body and loses its index row', async () => {
    await writeSkill('alpha');
    await writeSkill('beta');
    const { injector } = make('index');
    const out = await injector.inject(makeCtx({ roomSkills: ['alpha'] }));
    expect(out?.content).toContain('BODY OF alpha.');
    expect(out?.content).not.toContain('| `alpha` |');
    expect(out?.content).toContain('| `beta` |');
    expect(out?.content).not.toContain('BODY OF beta.');
  });

  it('ctx.skillsIndexMode: pinned skill still renders in full', async () => {
    await writeSkill('alpha');
    const { injector } = make('full');
    const out = await injector.inject(makeCtx({ roomSkills: ['alpha'], skillsIndexMode: true }));
    expect(out?.content).toContain('BODY OF alpha.');
    expect(out?.content).not.toContain('| `alpha` |');
  });

  it('full mode: pinned skill appears exactly once', async () => {
    await writeSkill('alpha');
    const { injector } = make('full');
    const out = await injector.inject(makeCtx({ roomSkills: ['alpha'] }));
    expect((out?.content ?? '').split('BODY OF alpha.').length - 1).toBe(1);
  });

  it('ineligible id is skipped and reported', async () => {
    await writeSkill('alpha');
    const { injector, skipped } = make('index');
    const out = await injector.inject(makeCtx({ roomSkills: ['ghost'] }));
    expect(out?.content).not.toContain('ghost');
    expect(skipped).toContainEqual(['ghost', 'room skill not eligible for personality']);
  });

  it('is byte-identical across two calls', async () => {
    await writeSkill('alpha');
    await writeSkill('beta');
    const { injector } = make('index');
    const ctx = () => makeCtx({ roomSkills: ['beta', 'alpha'] });
    const a = await injector.inject(ctx());
    const b = await injector.inject(ctx());
    expect(a?.content).toBe(b?.content);
  });

  it('caps at 8 room skills; extras are skipped via onSkip', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    for (const id of ids) await writeSkill(id);
    const { injector, skipped } = make('index');
    const out = await injector.inject(makeCtx({ roomSkills: ids }));
    for (const id of ids.slice(0, 8)) expect(out?.content).toContain(`BODY OF ${id}.`);
    for (const id of ids.slice(8)) {
      expect(out?.content).not.toContain(`BODY OF ${id}.`);
      expect(skipped.some(([s]) => s === id)).toBe(true);
    }
  });

  it('renders in roomSkills order', async () => {
    await writeSkill('alpha');
    await writeSkill('beta');
    const { injector } = make('index');
    const out = await injector.inject(makeCtx({ roomSkills: ['beta', 'alpha'] }));
    const c = out?.content ?? '';
    expect(c.indexOf('BODY OF beta.')).toBeGreaterThan(-1);
    expect(c.indexOf('BODY OF beta.')).toBeLessThan(c.indexOf('BODY OF alpha.'));
  });

  it('respects maxInjectionChars', async () => {
    await writeSkill('alpha', 'A'.repeat(200));
    const { injector, skipped } = make('index', 50);
    const out = await injector.inject(makeCtx({ roomSkills: ['alpha'] }));
    expect(out?.content ?? '').not.toContain('AAAA');
    expect(skipped).toContainEqual(['alpha', 'injection budget exceeded']);
  });

  it('index mode: a pinned skill that busts the budget keeps its index row', async () => {
    await writeSkill('alpha', 'A'.repeat(200));
    const { injector, skipped } = make('index', 50);
    const out = await injector.inject(makeCtx({ roomSkills: ['alpha'] }));
    const c = out?.content ?? '';
    expect(c).not.toContain('AAAA');
    expect(c).toContain('| `alpha` |');
    expect(skipped).toContainEqual(['alpha', 'injection budget exceeded']);
  });

  it('full mode: a pinned skill that busts the budget falls to the normal pass (also over budget), never duplicated', async () => {
    await writeSkill('alpha', 'A'.repeat(200));
    const { injector, skipped } = make('full', 50);
    const out = await injector.inject(makeCtx({ roomSkills: ['alpha'] }));
    const c = out?.content ?? '';
    expect(c).not.toContain('AAAA');
    expect(c).not.toContain('| `alpha` |');
    expect(skipped.filter(([id]) => id === 'alpha').length).toBe(1);
  });

  it('no roomSkills (or empty) leaves output unchanged', async () => {
    await writeSkill('alpha');
    const { injector } = make('index');
    const base = await injector.inject(makeCtx());
    const empty = await injector.inject(makeCtx({ roomSkills: [] }));
    expect(empty?.content).toBe(base?.content);
    expect(base?.content).toContain('| `alpha` |');
  });
});
