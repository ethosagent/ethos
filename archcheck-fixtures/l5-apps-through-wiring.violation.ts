// archcheck-fixture: place-at apps/archcheck-fixture/src/index.ts
//
// An app importing a concrete extension at runtime instead of reaching it through wiring. A
// value import, not `import type`: the rule sets ignoreTypeOnly.
import { extensionTarget } from '../../../extensions/archcheck-target/src/index';

export const leak = extensionTarget;
