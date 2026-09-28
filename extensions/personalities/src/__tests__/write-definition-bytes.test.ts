// plan personality-memory-boundary G2, prereq C — FilePersonalityRegistry.
// writeDefinitionBytes: the compare-and-swap writer self-amendment apply and
// rollback use. Refuses built-ins, refuses when the live bytes are not the
// ones the caller hashed, and writes through Storage.writeAtomic.
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import { DefinitionChangedError, FilePersonalityRegistry, hashDefinitionBytes } from '../index';

const DATA = '/data';
const DIR = join(DATA, 'personalities');
const TOOLSET = '- read_file\n';

async function setup(): Promise<{ storage: InMemoryStorage; registry: FilePersonalityRegistry }> {
  const storage = new InMemoryStorage();
  const pdir = join(DIR, 'scout');
  await storage.mkdir(pdir);
  await storage.write(join(pdir, 'config.yaml'), 'name: Scout\n');
  await storage.write(join(pdir, 'SOUL.md'), '# Scout\n');
  await storage.write(join(pdir, 'toolset.yaml'), TOOLSET);
  const registry = new FilePersonalityRegistry(storage, DATA);
  await registry.loadFromDirectory(DIR);
  return { storage, registry };
}

describe('FilePersonalityRegistry.writeDefinitionBytes', () => {
  it('writes exactly the given bytes when the live hash matches, and serves them', async () => {
    const { storage, registry } = await setup();
    const writeAtomic = vi.spyOn(storage, 'writeAtomic');
    const after = '- read_file\n- web_search\n';

    const described = await registry.writeDefinitionBytes('scout', 'toolset.yaml', after, {
      expectedHash: hashDefinitionBytes(TOOLSET),
    });

    expect(await storage.read(join(DIR, 'scout', 'toolset.yaml'))).toBe(after);
    // (InMemoryStorage.writeAtomic delegates to its own write(), so a spy on
    // write() proves nothing here; the FsStorage cases in update-roundtrip.test.ts
    // pin that no plain write reaches a definition file.)
    expect(writeAtomic).toHaveBeenCalledWith(join(DIR, 'scout', 'toolset.yaml'), after);
    expect(described.config.toolset).toEqual(['read_file', 'web_search']);
    expect(registry.get('scout')?.toolset).toEqual(['read_file', 'web_search']);
  });

  it('writes config.yaml too', async () => {
    const { storage, registry } = await setup();
    await registry.writeDefinitionBytes('scout', 'config.yaml', 'name: Scout v2\n', {
      expectedHash: hashDefinitionBytes('name: Scout\n'),
    });
    expect(await storage.read(join(DIR, 'scout', 'config.yaml'))).toBe('name: Scout v2\n');
    expect(registry.get('scout')?.name).toBe('Scout v2');
  });

  it('refuses with DefinitionChangedError and writes nothing when the file changed since it was hashed', async () => {
    const { storage, registry } = await setup();
    const expectedHash = hashDefinitionBytes(TOOLSET);
    // A hand edit lands between the caller's read and its write.
    const edited = '- read_file\n- terminal\n';
    await storage.write(join(DIR, 'scout', 'toolset.yaml'), edited);
    const writeAtomic = vi.spyOn(storage, 'writeAtomic');

    const err = await registry
      .writeDefinitionBytes('scout', 'toolset.yaml', '- web_search\n', { expectedHash })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DefinitionChangedError);
    expect(err).toMatchObject({
      code: 'CONFIG_CONFLICT',
      personalityId: 'scout',
      file: 'toolset.yaml',
      expectedHash,
      liveHash: hashDefinitionBytes(edited),
    });
    expect(writeAtomic).not.toHaveBeenCalled();
    expect(await storage.read(join(DIR, 'scout', 'toolset.yaml'))).toBe(edited);
  });

  it('refuses when the file is missing (liveHash null)', async () => {
    const { storage, registry } = await setup();
    await storage.remove(join(DIR, 'scout', 'toolset.yaml'));

    await expect(
      registry.writeDefinitionBytes('scout', 'toolset.yaml', TOOLSET, {
        expectedHash: hashDefinitionBytes(TOOLSET),
      }),
    ).rejects.toMatchObject({ name: 'DefinitionChangedError', liveHash: null });
    expect(await storage.exists(join(DIR, 'scout', 'toolset.yaml'))).toBe(false);
  });

  it('refuses a built-in personality with PERSONALITY_READ_ONLY and writes nothing', async () => {
    const { storage, registry } = await setup();
    const builtinDir = '/builtins/sage';
    await storage.mkdir(builtinDir);
    await storage.write(join(builtinDir, 'config.yaml'), 'name: Sage\n');
    await storage.write(join(builtinDir, 'SOUL.md'), '# Sage\n');
    await storage.write(join(builtinDir, 'toolset.yaml'), TOOLSET);
    await registry.loadFromDirectory('/builtins');
    expect(registry.describe('sage')?.builtin).toBe(true);
    const writeAtomic = vi.spyOn(storage, 'writeAtomic');

    await expect(
      registry.writeDefinitionBytes('sage', 'toolset.yaml', '- terminal\n', {
        expectedHash: hashDefinitionBytes(TOOLSET),
      }),
    ).rejects.toMatchObject({ code: 'PERSONALITY_READ_ONLY' });
    expect(writeAtomic).not.toHaveBeenCalled();
    expect(await storage.read(join(builtinDir, 'toolset.yaml'))).toBe(TOOLSET);
  });

  it('refuses an unknown personality with PERSONALITY_NOT_FOUND', async () => {
    const { registry } = await setup();
    await expect(
      registry.writeDefinitionBytes('ghost', 'toolset.yaml', TOOLSET),
    ).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
  });
});
