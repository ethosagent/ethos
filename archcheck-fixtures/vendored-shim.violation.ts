// archcheck-fixture: place-at packages/sqlite/src/archcheck-fixture.ts
//
// The sqlite shim reaching into core — Ethos semantics leaking into a platform wrapper.
import { coreTarget } from '../../core/src/archcheck-target';

export const leak = coreTarget;
