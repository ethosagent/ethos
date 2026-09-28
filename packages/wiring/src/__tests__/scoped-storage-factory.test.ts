// plan personality-memory-boundary-and-self-amendment, G1-5 — wiring's half of
// the shared-turn private memory deny.
//
// - `privateMemoryExtraRoots` (./memory-backend.ts) is what reaches
//   `AgentLoopConfig.privateMemoryRoots` (build-agent-loop.ts) and
//   `CapabilityBackends.privateMemoryRoots` (build-infrastructure.ts).
// - The factory's forwarding of `denyWhen` is checked by the conformance suite
//   on the shipped-bundle replica in `safety-conformance-wiring.test.ts`
//   (`runAgentSafetyConformance`'s shared-room case); the same replica caveat
//   stated there applies.

import { resolve } from 'node:path';
import { defaultAlwaysDeny, InMemoryStorage, ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError, privateMemoryPathDeny } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
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

describe('the shipped factory shape forwards denyWhen', () => {
  it('a spread scope reaches ScopedStorage and refuses the vault on a shared turn', async () => {
    // Same expression as `scopedStorageFactory` in build-agent-loop.ts.
    const factory = (
      base: InMemoryStorage,
      scope: ConstructorParameters<typeof ScopedStorage>[1],
    ) => new ScopedStorage(base, { ...scope, alwaysDeny: defaultAlwaysDeny() });
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
});
