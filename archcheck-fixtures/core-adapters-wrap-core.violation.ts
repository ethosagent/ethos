// archcheck-fixture: place-at packages/agent-bridge/src/archcheck-fixture.ts
//
// A core adapter reaching a concrete extension instead of taking it through a contract.
import { extensionTarget } from '../../../extensions/archcheck-target/src/index';

export const leak = extensionTarget;
