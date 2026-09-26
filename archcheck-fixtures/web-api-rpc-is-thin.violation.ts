// archcheck-fixture: place-at apps/web-api/src/rpc/archcheck-fixture.ts
//
// An rpc handler importing a concrete extension instead of calling a service method.
import { extensionTarget } from '../../../../extensions/archcheck-target/src/index';

export const leak = extensionTarget;
