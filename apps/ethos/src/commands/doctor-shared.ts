// Shared ANSI colour table and storage handle type for the doctor modules.
// Leaf module: imports nothing from doctor.ts so the split modules never form
// an import cycle.
import type { getStorage } from '../wiring';

// The ANSI colour table lives in ./_shared (one copy for every command); doctor
// modules keep importing it from here.
export { c } from './_shared';

export type Storage = ReturnType<typeof getStorage>;
