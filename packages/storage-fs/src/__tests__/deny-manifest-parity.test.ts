import { personalityDefinitionWriteFloor } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { defaultAlwaysDeny } from '../default-deny';
import { ethosStateDirs, personalityDefinitionFloor, sensitiveDenyPaths } from '../sensitive-paths';

// Parity: the ScopedStorage always-deny floor must be exactly the canonical
// manifest. Fails if `defaultAlwaysDeny` drifts from `sensitiveDenyPaths`.
describe('deny-manifest parity — ScopedStorage always-deny floor', () => {
  it('defaultAlwaysDeny() is exactly the canonical manifest', () => {
    expect(defaultAlwaysDeny()).toEqual(sensitiveDenyPaths());
  });
});

// plan personality-memory-boundary G2-pre B — both boundary copies judge the
// definition floor with ONE predicate: `ScopedStorage` calls
// `personalityDefinitionFloor()` itself and wiring hands the same function to
// `ScopedFsImpl` (`CapabilityBackends.definitionWriteFloor`). Fails if the
// storage-fs wrapper drifts from the `@ethosagent/types` predicate over the
// state dirs.
describe('deny-manifest parity — personality-definition write floor', () => {
  const probes = ethosStateDirs().flatMap((dir) => [
    `${dir}/personalities/a/toolset.yaml`,
    `${dir}/personalities/a/skills/s/SKILL.md`,
    `${dir}/personalities/a/MEMORY.md`,
    `${dir}/personalities/a/files/config.yaml`,
    `${dir}/personalities/a`,
    `${dir}/personalities`,
    `${dir}/toolset.yaml`,
    dir,
  ]);
  it.each(probes)('%s is judged identically', (path) => {
    const expected = personalityDefinitionWriteFloor(ethosStateDirs());
    for (const op of ['access', 'subtree'] as const) {
      expect(personalityDefinitionFloor()(path, op)).toBe(expected(path, op));
    }
  });
});
