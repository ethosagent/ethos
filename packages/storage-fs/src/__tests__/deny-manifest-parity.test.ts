import { describe, expect, it } from 'vitest';
import { defaultAlwaysDeny } from '../default-deny';
import { sensitiveDenyPaths } from '../sensitive-paths';

// Parity: the ScopedStorage always-deny floor must be exactly the canonical
// manifest. Fails if `defaultAlwaysDeny` drifts from `sensitiveDenyPaths`.
describe('deny-manifest parity — ScopedStorage always-deny floor', () => {
  it('defaultAlwaysDeny() is exactly the canonical manifest', () => {
    expect(defaultAlwaysDeny()).toEqual(sensitiveDenyPaths());
  });
});
