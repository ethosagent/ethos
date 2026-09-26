// archcheck-fixture: place-at packages/safety/redact/src/archcheck-fixture.ts
//
// A security-kernel package depending on core rather than on a contract.
import { coreTarget } from '../../../core/src/archcheck-target';

export const leak = coreTarget;
