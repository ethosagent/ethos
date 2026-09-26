// archcheck-fixture: place-at packages/core/src/archcheck-fixture.ts
//
// core importing a concrete extension instead of receiving it through AgentLoopConfig.
import { extensionTarget } from '../../../extensions/archcheck-target/src/index';

export const leak = extensionTarget;
