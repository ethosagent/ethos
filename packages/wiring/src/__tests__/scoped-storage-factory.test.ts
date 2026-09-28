// plan personality-memory-boundary-and-self-amendment, G1-5 — wiring's half of
// the shared-turn private memory deny.
//
// - `privateMemoryExtraRoots` (./memory-backend.ts) is what reaches
//   `AgentLoopConfig.privateMemoryRoots` (build-agent-loop.ts) and
//   `CapabilityBackends.privateMemoryRoots` (build-infrastructure.ts).
// - The REAL factory (`shippedScopedStorageFactory`, build-agent-loop.ts — the
//   function `buildAgentLoop` puts on `AgentSafety.scopedStorageFactory`)
//   forwards `denyWhen` and keeps the personality-definition floor
//   (verification round B6; it used to be checked on a replica only).

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as storageFs from '@ethosagent/storage-fs';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { BoundaryError, privateMemoryPathDeny } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { shippedScopedStorageFactory } from '../build-agent-loop';
import { privateMemoryExtraRoots } from '../memory-backend';

describe('privateMemoryExtraRoots', () => {
  it('is the resolved vault root whenever memoryVault.path is configured', () => {
    expect(privateMemoryExtraRoots({ memory: 'vault', memoryVault: { path: 'notes/v' } })).toEqual([
      resolve('notes/v'),
    ]);
  });

  it('keeps the vault root even when the top-level backend is not vault', () => {
    // The vault provider is registered for every personality, whatever
    // `memory:` says, so its root is private whenever it is configured.
    expect(privateMemoryExtraRoots({ memory: 'markdown', memoryVault: { path: '/v' } })).toEqual([
      '/v',
    ]);
  });

  it('is empty with no vault configured', () => {
    expect(privateMemoryExtraRoots({ memory: 'markdown' })).toEqual([]);
    expect(privateMemoryExtraRoots({})).toEqual([]);
  });
});

describe('the shipped factory (shippedScopedStorageFactory)', () => {
  const factory = shippedScopedStorageFactory(storageFs);

  it('forwards denyWhen: the vault is refused on a shared turn', async () => {
    const base = new InMemoryStorage();
    await base.mkdir('/v');
    await base.write('/v/journal.md', 'vault note');
    const scoped = factory(base, {
      read: ['/v/'],
      write: [],
      denyWhen: privateMemoryPathDeny({
        stateDirs: ['/home/u/.ethos'],
        extraRoots: privateMemoryExtraRoots({ memoryVault: { path: '/v' } }),
      }),
    });
    await expect(scoped.read('/v/journal.md')).rejects.toBeInstanceOf(BoundaryError);
  });

  it('forwards denyWhen: MEMORY.md under the state dir is refused, read and write', async () => {
    const stateDir = join(homedir(), '.ethos');
    const memoryFile = join(stateDir, 'personalities', 'p', 'MEMORY.md');
    const base = new InMemoryStorage();
    await base.mkdir(join(stateDir, 'personalities', 'p'));
    await base.write(memoryFile, 'private');
    const scoped = factory(base, {
      read: [`${stateDir}/`],
      write: [`${stateDir}/`],
      denyWhen: privateMemoryPathDeny({ stateDirs: [stateDir], extraRoots: [] }),
    });
    await expect(scoped.read(memoryFile)).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.write(memoryFile, 'x')).rejects.toBeInstanceOf(BoundaryError);
  });

  it('keeps the personality-definition floor even with the directory in write scope', async () => {
    const dir = join(homedir(), '.ethos', 'personalities', 'p');
    const base = new InMemoryStorage();
    await base.mkdir(dir);
    const scoped = factory(base, { read: [`${dir}/`], write: [`${dir}/`] });
    await expect(scoped.write(join(dir, 'toolset.yaml'), '- terminal\n')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    // A private turn carries no predicate: the same scope's MEMORY.md is writable.
    await expect(scoped.write(join(dir, 'MEMORY.md'), 'ok')).resolves.toBeUndefined();
  });
});
