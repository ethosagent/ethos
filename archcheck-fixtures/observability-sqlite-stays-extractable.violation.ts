// archcheck-fixture: place-at extensions/observability-sqlite/src/archcheck-fixture.ts
//
// observability-sqlite reaching into core. It may depend only on contracts, the security kernel
// and the sqlite shim, so any core import breaks its extractability.
import { coreTarget } from '../../../packages/core/src/archcheck-target';

export const leak = coreTarget;
