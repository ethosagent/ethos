// archcheck-fixture: place-at extensions/archcheck-fixture/src/reaches-wiring.ts
//
// An extension reaching up into the composition root.
import { wiringTarget } from '../../../packages/wiring/src/archcheck-target';

export const leak = wiringTarget;
