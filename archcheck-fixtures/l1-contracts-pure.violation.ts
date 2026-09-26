// archcheck-fixture: place-at packages/types/src/archcheck-fixture.ts
//
// @ethosagent/types importing another layer. Its allow-list is empty: it imports nothing.
import { coreTarget } from '../../core/src/archcheck-target';

export const leak = coreTarget;
