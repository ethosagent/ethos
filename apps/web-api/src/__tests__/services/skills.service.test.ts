import { join } from 'node:path';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { SkillsService } from '../../services/skills.service';

// Gap 11 — the service must surface the library's real `unavailableReason`
// on the wire (it used to hardcode null), and `includeUnavailable` must
// round-trip to the library's filter.

const DATA = '/data';

const NEEDS_BASH = [
  '---',
  'name: Needs Bash',
  'ethos:',
  '  requires:',
  '    tools: [bash]',
  '---',
  '',
  'body',
].join('\n');

async function makeService(availableTools: () => Set<string>) {
  const storage = new InMemoryStorage();
  await storage.mkdir(join(DATA, 'skills'));
  await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);
  await storage.write(join(DATA, 'skills', 'plain.md'), '---\nname: Plain\n---\n\nplain body');
  const library = new SkillsLibrary({ dataDir: DATA, storage, availableTools });
  return new SkillsService({ library });
}

describe('SkillsService', () => {
  it('list excludes unavailable skills by default', async () => {
    const service = await makeService(() => new Set<string>());
    const { skills } = await service.list();
    expect(skills.map((s) => s.id)).toEqual(['plain']);
  });

  it('list maps the real unavailableReason to the wire when includeUnavailable is set', async () => {
    const service = await makeService(() => new Set<string>());
    const { skills } = await service.list({ includeUnavailable: true });
    expect(skills.map((s) => [s.id, s.unavailableReason])).toEqual([
      ['needs-bash', 'tool bash not available'],
      ['plain', null],
    ]);
  });

  it('list reports the skill available when its required tool is registered', async () => {
    const service = await makeService(() => new Set(['bash']));
    const { skills } = await service.list();
    expect(skills.map((s) => [s.id, s.unavailableReason])).toEqual([
      ['needs-bash', null],
      ['plain', null],
    ]);
  });

  it('get surfaces unavailableReason on the wire', async () => {
    const service = await makeService(() => new Set<string>());
    const { skill } = await service.get('needs-bash');
    expect(skill.unavailableReason).toBe('tool bash not available');
  });
});

// Plan skill-history-and-lock, Lane D: history, version bytes, restore and the
// lock — for a shared skill and for a personality's own (`personalityId`).
describe('SkillsService — history and lock', () => {
  async function fresh() {
    const storage = new InMemoryStorage();
    await storage.mkdir(join(DATA, 'skills'));
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    return { storage, library, service: new SkillsService({ library }) };
  }

  it('list and get carry locked and versionCount', async () => {
    const { service } = await fresh();
    await service.create({ id: 'tidy', body: 'one' });
    await service.update({ id: 'tidy', body: 'two' });
    const { skills } = await service.list();
    expect(skills[0]).toMatchObject({ id: 'tidy', locked: false, versionCount: 2 });
    await service.setLock({ id: 'tidy', locked: true });
    expect((await service.get('tidy')).skill).toMatchObject({ locked: true, versionCount: 2 });
  });

  it('a skill whose filename is not a safe id lists with no history instead of failing the list', async () => {
    const { storage, service } = await fresh();
    await storage.write(join(DATA, 'skills', 'v1.2 notes.md'), 'odd name');
    const { skills } = await service.list();
    expect(skills[0]).toMatchObject({ id: 'v1.2 notes', locked: false, versionCount: 0 });
  });

  it('history lists versions oldest first; version returns the bytes', async () => {
    const { service } = await fresh();
    await service.create({ id: 'tidy', body: 'one' });
    await service.update({ id: 'tidy', body: 'two' });
    const { versions } = await service.history({ id: 'tidy' });
    expect(versions.map((v) => v.source)).toEqual(['web-edit', 'web-edit']);
    const first = versions[0];
    if (!first) throw new Error('no versions');
    expect(await service.version({ id: 'tidy', versionId: first.versionId })).toEqual({
      versionId: first.versionId,
      content: 'one\n',
    });
  });

  it('restore brings an older version back as a new restore version', async () => {
    const { storage, service } = await fresh();
    await service.create({ id: 'tidy', body: 'one' });
    await service.update({ id: 'tidy', body: 'two' });
    const first = (await service.history({ id: 'tidy' })).versions[0];
    if (!first) throw new Error('no versions');
    const restored = await service.restore({ id: 'tidy', versionId: first.versionId });
    expect(await storage.read(join(DATA, 'skills', 'tidy.md'))).toBe('one\n');
    const last = (await service.history({ id: 'tidy' })).versions.at(-1);
    expect(last).toMatchObject({ source: 'restore', restoredFrom: first.versionId, actor: 'web' });
    expect(restored.versionId).toBe(last?.versionId);
  });

  it('works for a personality-scoped skill through personalityId', async () => {
    const { storage, library, service } = await fresh();
    await library.createPersonalitySkill('coach', 'tidy', 'one');
    await library.updatePersonalitySkill('coach', 'tidy', 'two');
    const input = { id: 'tidy', personalityId: 'coach' };
    expect((await service.history(input)).versions).toHaveLength(2);
    expect(await service.setLock({ ...input, locked: true })).toEqual({ locked: true });
    expect(
      await storage.exists(
        join(DATA, 'personalities', 'coach', 'skills', '.history', 'tidy', 'lock.json'),
      ),
    ).toBe(true);
    // the shared skill of the same id is untouched
    expect(await storage.exists(join(DATA, 'skills', '.history'))).toBe(false);
    const first = (await service.history(input)).versions[0];
    if (!first) throw new Error('no versions');
    await service.restore({ ...input, versionId: first.versionId });
    expect(await storage.read(join(DATA, 'personalities', 'coach', 'skills', 'tidy.md'))).toBe(
      'one\n',
    );
  });

  it('a human edit of a locked skill still works (lock blocks agents only)', async () => {
    const { service } = await fresh();
    await service.create({ id: 'tidy', body: 'one' });
    await service.setLock({ id: 'tidy', locked: true });
    await expect(service.update({ id: 'tidy', body: 'two' })).resolves.toBeDefined();
  });

  it('refuses to lock or restore a skill that does not exist, and unknown versions', async () => {
    const { service } = await fresh();
    await expect(service.setLock({ id: 'ghost', locked: true })).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    await service.create({ id: 'tidy', body: 'one' });
    await expect(service.restore({ id: 'tidy', versionId: 'nope' })).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    expect(await service.version({ id: 'tidy', versionId: 'nope' })).toEqual({
      versionId: 'nope',
      content: null,
    });
  });

  it('rejects an unsafe id before touching storage', async () => {
    const { service } = await fresh();
    await expect(service.history({ id: '../etc' })).rejects.toThrow(/Invalid skillId/);
  });
});
