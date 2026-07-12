import { join } from 'node:path';
import type { EvolveConfig } from '@ethosagent/skill-evolver';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvolverRepository } from '../../repositories/evolver.repository';

const DATA = '/data';

const CONFIG: EvolveConfig = {
  rewriteThreshold: 0.5,
  newSkillPatternThreshold: 0.6,
  minRunsBeforeEvolve: 3,
  minPatternCount: 2,
  autoApprove: true,
};

describe('EvolverRepository', () => {
  let storage: InMemoryStorage;
  let repo: EvolverRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    repo = new EvolverRepository({ dataDir: DATA, storage });
  });

  it('writes evolve-config.json atomically (no partial-write corruption)', async () => {
    // InMemoryStorage.writeAtomic delegates to write internally, so we can't
    // assert write() was never called — spying on writeAtomic proves the repo
    // took the atomic path rather than a bare write.
    const writeAtomic = vi.spyOn(storage, 'writeAtomic');

    await repo.setConfig(CONFIG);

    const path = join(DATA, 'evolve-config.json');
    expect(writeAtomic).toHaveBeenCalledWith(path, expect.any(String));
  });

  it('round-trips config through setConfig then getConfig', async () => {
    await repo.setConfig(CONFIG);
    const read = await repo.getConfig();
    expect(read).toEqual(CONFIG);
  });
});
