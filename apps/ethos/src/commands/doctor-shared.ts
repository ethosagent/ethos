// Shared ANSI colour table and storage handle type for the doctor modules.
// Leaf module: imports nothing from doctor.ts so the split modules never form
// an import cycle.
import type { getStorage } from '../wiring';

export const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

export type Storage = ReturnType<typeof getStorage>;
