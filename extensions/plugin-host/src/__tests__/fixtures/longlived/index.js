export function activate(api) {
  api.registerRoute({ method: 'GET', path: '/ll/ping', handler: async () => ({ body: 'pong' }) });
  api.registerTool({
    name: 'll_pid',
    description: 'pid',
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async () => ({ ok: true, value: String(process.pid) }),
  });
}
