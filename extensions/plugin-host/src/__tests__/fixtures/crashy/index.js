import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = { schema: { type: 'object', properties: {} }, capabilities: {} };
const countFile = join(process.env.HOME, 'activations.log');
appendFileSync(countFile, 'x');
const activation = readFileSync(countFile, 'utf8').length;

export function activate(api) {
  api.registerTool({
    ...base,
    name: 'ok',
    description: 'Always answers',
    execute: async () => ({ ok: true, value: 'ok' }),
  });
  api.registerTool({
    ...base,
    name: 'counter',
    // Differs on every activation, so a restart is registration drift.
    description: `Activation number ${activation}`,
    execute: async () => ({ ok: true, value: String(activation) }),
  });
  api.registerTool({
    ...base,
    name: 'exit_now',
    description: 'process.exit(3) mid-call',
    execute: async () => process.exit(3),
  });
  api.registerTool({
    ...base,
    name: 'kill_self',
    description: 'SIGKILL mid-call',
    execute: async () => {
      process.kill(process.pid, 'SIGKILL');
      return new Promise(() => {});
    },
  });
  api.registerTool({
    ...base,
    name: 'heap_blow',
    description: 'Allocates until V8 hits max_heap_mb',
    execute: async () => {
      const hold = [];
      for (;;) hold.push(new Array(1_000_000).fill(Math.random()));
    },
  });
}
