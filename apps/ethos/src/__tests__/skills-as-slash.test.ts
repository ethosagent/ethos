import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { refreshSkillIfStale, scanSkillsIntoRegistry } from '../lib/skill-slash';
import { buildBaseRegistry } from '../lib/slash-commands';

describe('scanSkillsIntoRegistry', () => {
  it('registers a global skill as /<slug> with [skill] prefix', async () => {
    const storage = new InMemoryStorage();
    const skillsDir = '/ethos/skills';
    await storage.mkdir(skillsDir);
    await storage.write(join(skillsDir, 'my-skill.md'), '# My Skill\nDoes things.');

    const registry = buildBaseRegistry();
    const cache = new Map();
    await scanSkillsIntoRegistry(storage, skillsDir, null, registry, cache);

    const cmd = registry.get('my-skill');
    expect(cmd).toBeDefined();
    expect(cmd?.prefix).toBe('[skill]');
    expect(cmd?.name).toBe('my-skill');
  });

  it('uses description from frontmatter when present', async () => {
    const storage = new InMemoryStorage();
    const skillsDir = '/ethos/skills';
    await storage.mkdir(skillsDir);
    await storage.write(
      join(skillsDir, 'summarize.md'),
      '---\ndescription: Summarize a document\nusage: /summarize <path>\n---\nSkill body.',
    );

    const registry = buildBaseRegistry();
    const cache = new Map();
    await scanSkillsIntoRegistry(storage, skillsDir, null, registry, cache);

    const cmd = registry.get('summarize');
    expect(cmd?.description).toBe('Summarize a document');
    expect(cmd?.usage).toBe('/summarize <path>');
    expect(cache.get('summarize')?.usage).toBe('/summarize <path>');
  });

  it('falls back to "Skill: <slug>" when description is absent', async () => {
    const storage = new InMemoryStorage();
    const skillsDir = '/ethos/skills';
    await storage.mkdir(skillsDir);
    await storage.write(join(skillsDir, 'my-tool.md'), 'No frontmatter here.');

    const registry = buildBaseRegistry();
    const cache = new Map();
    await scanSkillsIntoRegistry(storage, skillsDir, null, registry, cache);

    expect(registry.get('my-tool')?.description).toBe('Skill: my-tool');
  });

  it('scans per-personality skills/ directory', async () => {
    const storage = new InMemoryStorage();
    const globalDir = '/ethos/skills';
    const personalityDir = '/ethos/personalities/researcher/skills';
    await storage.mkdir(globalDir);
    await storage.mkdir(personalityDir);
    await storage.write(join(personalityDir, 'pers-skill.md'), 'Personality-specific skill.');

    const registry = buildBaseRegistry();
    const cache = new Map();
    await scanSkillsIntoRegistry(storage, globalDir, personalityDir, registry, cache);

    expect(registry.get('pers-skill')).toBeDefined();
  });

  it('skips non-.md files', async () => {
    const storage = new InMemoryStorage();
    const skillsDir = '/ethos/skills';
    await storage.mkdir(skillsDir);
    await storage.write(join(skillsDir, 'README.txt'), 'readme');

    const registry = buildBaseRegistry();
    const cache = new Map();
    await scanSkillsIntoRegistry(storage, skillsDir, null, registry, cache);

    expect(registry.get('README')).toBeUndefined();
  });
});

describe('refreshSkillIfStale', () => {
  it('re-reads content when mtime changes', async () => {
    const storage = new InMemoryStorage();
    const skillsDir = '/ethos/skills';
    await storage.mkdir(skillsDir);
    const filePath = join(skillsDir, 'evolving.md');
    await storage.write(filePath, 'original content');

    const registry = buildBaseRegistry();
    const cache = new Map();
    await scanSkillsIntoRegistry(storage, skillsDir, null, registry, cache);

    // Mutate mtime in cache to simulate stale
    const meta = cache.get('evolving');
    expect(meta).toBeDefined();
    if (meta) {
      meta.mtimeMs = 0;
      await storage.write(filePath, 'updated content');
      const refreshed = await refreshSkillIfStale(storage, 'evolving', cache);
      expect(refreshed?.content).toBe('updated content');
    }
  });

  it('returns undefined for unknown slug', async () => {
    const cache = new Map();
    const storage = new InMemoryStorage();
    const result = await refreshSkillIfStale(storage, 'nonexistent', cache);
    expect(result).toBeUndefined();
  });
});
