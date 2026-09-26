// archcheck-fixture: place-at packages/logger/src/archcheck-fixture.ts
//
// A library package depending on core instead of on a contract.
import { coreTarget } from '../../core/src/archcheck-target';

export const leak = coreTarget;
