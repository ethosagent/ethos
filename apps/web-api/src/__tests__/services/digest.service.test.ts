import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DigestService } from '../../services/digest.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

const DATA = '/data';
const USER_DIR = join(DATA, 'personalities');

// A user (non-builtin) personality: its soulFile lives under the user dir, so
// `describeAll()` reports `builtin: false` and `generate()` includes it.
function userPersonality(id: string): PersonalityConfig {
  return { id, name: id, soulFile: join(USER_DIR, id, 'SOUL.md') };
}

describe('DigestService.latest', () => {
  it('returns null when the digests dir is missing', async () => {
    const storage = new InMemoryStorage();
    const service = new DigestService({
      storage,
      dataDir: DATA,
      personalities: makeStubPersonalityRegistry(),
    });
    expect(await service.latest()).toBeNull();
  });

  it('returns null when the dir exists but holds no .md files', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(join(DATA, 'digests'));
    await storage.write(join(DATA, 'digests', 'notes.txt'), 'ignore me');
    const service = new DigestService({
      storage,
      dataDir: DATA,
      personalities: makeStubPersonalityRegistry(),
    });
    expect(await service.latest()).toBeNull();
  });

  it('picks the lexicographically-greatest (newest ISO-week) file', async () => {
    const storage = new InMemoryStorage();
    const dir = join(DATA, 'digests');
    await storage.mkdir(dir);
    await storage.write(join(dir, '2026-W06.md'), '# old');
    await storage.write(join(dir, '2026-W07.md'), '# newest');
    await storage.write(join(dir, '2025-W52.md'), '# oldest');
    const service = new DigestService({
      storage,
      dataDir: DATA,
      personalities: makeStubPersonalityRegistry(),
    });
    const latest = await service.latest();
    expect(latest?.label).toBe('2026-W07');
    expect(latest?.markdown).toBe('# newest');
    expect(typeof latest?.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(latest?.generatedAt ?? ''))).toBe(false);
  });
});

describe('DigestService.generate', () => {
  it('returns null when there are no user personalities', async () => {
    const storage = new InMemoryStorage();
    const service = new DigestService({
      storage,
      dataDir: DATA,
      personalities: makeStubPersonalityRegistry(),
    });
    expect(await service.generate()).toBeNull();
  });

  it('writes the current ISO-week digest and returns it', async () => {
    const storage = new InMemoryStorage();
    const registry = makeStubPersonalityRegistry([userPersonality('coder')], DATA);
    const service = new DigestService({ storage, dataDir: DATA, personalities: registry });

    const result = await service.generate();
    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected a digest');
    expect(result.markdown).toContain('## coder');
    expect(result.markdown).toContain('Weekly governed-learning digest');
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);

    // The file was written to <dataDir>/digests/<label>.md.
    const written = await storage.read(join(DATA, 'digests', `${result.label}.md`));
    expect(written).toBe(result.markdown);
  });

  it('latest() then returns what generate() wrote', async () => {
    const storage = new InMemoryStorage();
    const registry = makeStubPersonalityRegistry([userPersonality('coder')], DATA);
    const service = new DigestService({ storage, dataDir: DATA, personalities: registry });

    const generated = await service.generate();
    if (generated === null) throw new Error('expected a digest');
    const latest = await service.latest();
    expect(latest?.label).toBe(generated.label);
    expect(latest?.markdown).toBe(generated.markdown);
  });
});
