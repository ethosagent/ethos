import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const text = (value) => ({ ok: true, value });
const base = {
  schema: { type: 'object', properties: { text: { type: 'string' } } },
  capabilities: {},
};

export function activate(api) {
  appendFileSync(join(process.env.HOME, 'activations.log'), 'x');
  api.registerTool({
    ...base,
    name: 'echo',
    description: 'Echo the text argument',
    toolset: 'fixture',
    execute: async (args) => text(String(args?.text ?? '')),
  });
  api.registerTool({
    ...base,
    name: 'echo_pid',
    description: 'Report the host pid',
    execute: async () => text(String(process.pid)),
  });
  api.registerTool({
    ...base,
    name: 'echo_activations',
    description: 'How many times this plugin was activated in this host home',
    execute: async () =>
      text(String(readFileSync(join(process.env.HOME, 'activations.log'), 'utf8').length)),
  });
  api.registerTool({
    ...base,
    name: 'echo_log',
    description: 'Write to stdout and stderr, then answer',
    execute: async () => {
      console.log('hello from plugin stdout');
      console.error('hello from plugin stderr');
      return text('logged');
    },
  });
  api.registerTool({
    ...base,
    name: 'echo_throw',
    description: 'Throws',
    execute: async () => {
      throw new Error('boom');
    },
  });
  api.registerTool({
    ...base,
    name: 'echo_storage',
    description: 'Reads a path through ctx.storage',
    execute: async (args, ctx) => text(String(await ctx.storage.read(args.path))),
  });
  api.registerTool({
    ...base,
    name: 'echo_subscribe',
    description: 'Subscribes to a bus event, which makes the host long-lived',
    execute: async () => {
      api.on('echo.event', () => {});
      return text('subscribed');
    },
  });
  api.registerTool({
    ...base,
    name: 'echo_unavailable',
    description: 'Never available',
    isAvailable: () => false,
    execute: async () => text('unreachable'),
  });
}
