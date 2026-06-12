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
