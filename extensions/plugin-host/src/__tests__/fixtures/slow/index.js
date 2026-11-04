const base = {
  schema: { type: 'object', properties: { ms: { type: 'number' } } },
  capabilities: {},
};

export function activate(api) {
  api.registerTool({
    ...base,
    name: 'sleep',
    description: 'Sleeps ms, and stops early when aborted',
    execute: (args, ctx) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve({ ok: true, value: 'slept' }), Number(args?.ms ?? 100));
        ctx.abortSignal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve({ ok: false, code: 'execution_failed', error: 'stopped by abort' });
        });
      }),
  });
  api.registerTool({
    ...base,
    name: 'ignore_abort',
    description: 'Sleeps ms and ignores abort',
    execute: (args) =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: true, value: 'slept' }), Number(args?.ms ?? 100)),
      ),
  });
  api.registerTool({
    ...base,
    name: 'busy_loop',
    description: 'Blocks the event loop forever',
    execute: async () => {
      for (;;) {}
    },
  });
}
