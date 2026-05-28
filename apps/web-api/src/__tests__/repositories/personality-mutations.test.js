import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';

// Personality CRUD now lives directly on FilePersonalityRegistry. This
// test is the old PersonalityRepository regression suite (kept intact)
// pointed at the registry's create/update/deletePersonality/duplicate
// methods so the on-disk round-trip + mtime cache still hold.
const DATA = '/data';
describe('FilePersonalityRegistry — CRUD mutations', () => {
  let storage;
  let registry;
  beforeEach(() => {
    storage = new InMemoryStorage();
    registry = new FilePersonalityRegistry(storage, DATA);
  });
  describe('create', () => {
    it('writes the four files and refreshes the registry', async () => {
      const created = await registry.create({
        id: 'strategist',
        name: 'Strategist',
        description: 'thinks in moves',
        model: 'claude-opus-4-7',
        toolset: ['web_search', 'memory_read'],
        soulMd: '# I am a strategist\n',
      });
      expect(created.config.id).toBe('strategist');
      expect(created.config.name).toBe('Strategist');
      expect(created.config.toolset).toEqual(['web_search', 'memory_read']);
      expect(created.builtin).toBe(false);
      const personalityDir = join(DATA, 'personalities', 'strategist');
      expect(await storage.read(join(personalityDir, 'config.yaml'))).toContain('name: Strategist');
      expect(await storage.read(join(personalityDir, 'toolset.yaml'))).toContain('- web_search');
      expect(await storage.read(join(personalityDir, 'SOUL.md'))).toBe('# I am a strategist\n');
    });
    it('rejects duplicate ids with PERSONALITY_EXISTS', async () => {
      await registry.create({ id: 'one', name: 'One', toolset: [], soulMd: '' });
      await expect(
        registry.create({ id: 'one', name: 'One redux', toolset: [], soulMd: '' }),
      ).rejects.toMatchObject({ code: 'PERSONALITY_EXISTS' });
    });
  });
  describe('update', () => {
    it('writes SOUL.md when patch.soulMd is present', async () => {
      await registry.create({ id: 'p', name: 'P', toolset: [], soulMd: 'old' });
      await registry.update('p', { soulMd: 'new identity' });
      expect(await registry.readSoulMd('p')).toBe('new identity');
    });
    it('updates config.yaml when name/description/model change', async () => {
      await registry.create({ id: 'p', name: 'Old', toolset: [], soulMd: '' });
      await registry.update('p', { name: 'New', description: 'now updated' });
      const yaml = await storage.read(join(DATA, 'personalities', 'p', 'config.yaml'));
      expect(yaml).toContain('name: New');
      expect(yaml).toContain('description: now updated');
    });
    it('refreshes toolset.yaml when patch.toolset is present', async () => {
      await registry.create({ id: 'p', name: 'P', toolset: ['a'], soulMd: '' });
      await registry.update('p', { toolset: ['x', 'y'] });
      const yaml = await storage.read(join(DATA, 'personalities', 'p', 'toolset.yaml'));
      expect(yaml).toContain('- x');
      expect(yaml).toContain('- y');
      expect(yaml).not.toContain('- a');
    });
    it('rejects builtin personalities with PERSONALITY_READ_ONLY', async () => {
      registry.define({
        id: 'reviewer',
        name: 'Reviewer',
        soulFile: '/usr/share/ethos/personalities/reviewer/SOUL.md',
      });
      await expect(registry.update('reviewer', { soulMd: 'try' })).rejects.toMatchObject({
        code: 'PERSONALITY_READ_ONLY',
      });
    });
    it('rejects unknown ids with PERSONALITY_NOT_FOUND', async () => {
      await expect(registry.update('ghost', { soulMd: 'x' })).rejects.toMatchObject({
        code: 'PERSONALITY_NOT_FOUND',
      });
    });
  });
  describe('deletePersonality', () => {
    it('removes the directory and forgets the personality', async () => {
      await registry.create({ id: 'gone', name: 'Gone', toolset: [], soulMd: '' });
      await registry.deletePersonality('gone');
      expect(registry.describe('gone')).toBeNull();
      expect(await storage.exists(join(DATA, 'personalities', 'gone'))).toBe(false);
    });
    it('rejects builtins', async () => {
      registry.define({
        id: 'builtin',
        name: 'Builtin',
        soulFile: '/usr/share/ethos/personalities/builtin/SOUL.md',
      });
      await expect(registry.deletePersonality('builtin')).rejects.toMatchObject({
        code: 'PERSONALITY_READ_ONLY',
      });
    });
  });
  describe('duplicate', () => {
    it('copies a built-in into ~/.ethos/personalities/ with the new id and a renamed display name', async () => {
      const builtinDir = '/builtins';
      const sourceDir = '/builtins/engineer';
      await storage.mkdir(sourceDir);
      await storage.write(
        join(sourceDir, 'config.yaml'),
        'name: Engineer\ndescription: terse + correct\n',
      );
      await storage.write(join(sourceDir, 'toolset.yaml'), '- terminal\n- read_file\n');
      await storage.write(join(sourceDir, 'SOUL.md'), '# Engineer body\n');
      await registry.loadFromDirectory(builtinDir);
      const dup = await registry.duplicate('engineer', 'engineer-copy');
      expect(dup.config.id).toBe('engineer-copy');
      expect(dup.config.name).toBe('Engineer (copy)');
      expect(dup.builtin).toBe(false);
      const copyDir = join(DATA, 'personalities', 'engineer-copy');
      expect(await storage.read(join(copyDir, 'SOUL.md'))).toBe('# Engineer body\n');
      const yaml = await storage.read(join(copyDir, 'config.yaml'));
      expect(yaml).toContain('name: Engineer (copy)');
      expect(yaml).toContain('description: terse + correct');
    });
    it('rejects when the new id collides', async () => {
      await registry.create({ id: 'taken', name: 'Taken', toolset: [], soulMd: '' });
      registry.define({
        id: 'src',
        name: 'Src',
        soulFile: '/tmp/fake/src/SOUL.md',
      });
      await expect(registry.duplicate('src', 'taken')).rejects.toMatchObject({
        code: 'PERSONALITY_EXISTS',
      });
    });
    it('rejects when the source is unknown', async () => {
      await expect(registry.duplicate('missing', 'new')).rejects.toMatchObject({
        code: 'PERSONALITY_NOT_FOUND',
      });
    });
  });
});
