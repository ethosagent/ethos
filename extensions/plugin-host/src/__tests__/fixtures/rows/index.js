import { join } from 'node:path';

const text = (value) => ({ ok: true, value });
const base = { schema: { type: 'object', properties: {} }, capabilities: {} };
const received = [];
const credentialUpdates = [];
let monitorRuns = 0;

export function activate(api) {
  api.registerInjector({
    id: 'rows-injector',
    priority: 5,
    shouldInject: (ctx) => ctx.platform !== 'skip',
    inject: async (ctx) => {
      ctx.meta = { ...(ctx.meta ?? {}), seen: ctx.sessionId };
      return { content: `hello ${ctx.sessionId}`, position: 'append', section: 'rows' };
    },
  });
  api.registerToolFilter({
    toolName: 'echo',
    before: async (args) =>
      args?.block ? { ok: false, code: 'execution_failed', error: 'blocked by filter' } : null,
    after: async (result) => (result.ok ? { ...result, value: `${result.value}!` } : result),
  });
  api.registerEvaluator({
    name: 'rows-evaluator',
    shouldRun: (p) => p.text !== 'skip',
    evaluate: async (p) => ({ pass: p.text !== 'bad', reason: 'checked', score: 1 }),
  });
  api.registerRoute({
    method: 'POST',
    path: '/rows/echo',
    handler: async (req) => ({ status: 201, body: { echo: req.body }, headers: { 'x-rows': '1' } }),
  });
  api.registerRoute({
    method: 'GET',
    path: '/rows/bin',
    handler: async () => ({ body: Buffer.from('bin-data') }),
  });
  api.registerPersonality({ id: 'rows-persona', name: 'Rows persona' });
  api.registerOAuthProfile({ id: 'rows-profile', flow: { kind: 'authorization_code' } });
  api.registerPluginPage({ title: 'Rows page', sections: [] });
  api.registerRenderer({ type: 'rows-render', template: 'table' });
  api.registerDataSource('db', join(process.env.HOME, 'data.sqlite'));
  api.registerHealthCheck({
    name: 'rows-health',
    description: 'always fine',
    run: async () => ({ status: 'ok', message: 'fine' }),
  });
  api.registerSlashCommand({
    name: 'Rows',
    description: 'slash',
    usage: '/rows',
    handler: async (args, ctx) => {
      await ctx.send('sending');
      const stored = ctx.storage ? await ctx.storage.read('/slash/path') : 'no-storage';
      return `rows:${args}:registry=${ctx.toolRegistry === undefined}:storage=${stored}`;
    },
  });
  api.registerCliSubcommand({
    name: 'rowscli',
    description: 'cli',
    handler: async (ctx) => {
      ctx.stdout('out-line');
      ctx.stderr('err-line');
      return ctx.argv.length;
    },
  });
  api.registerCommand({
    name: 'rowscmd',
    description: 'command',
    run: async (ctx) => ({ exitCode: 0, output: `tools-absent=${ctx.tools === undefined}` }),
  });
  api.registerDocumentExtractor({
    name: 'rows-extractor',
    mimeTypes: ['application/x-rows'],
    extract: async (bytes) => ({
      text: Buffer.from(bytes).toString('utf8').toUpperCase(),
      format: 'text',
    }),
  });
  api.registerVoidHook('agent_done', async (payload) => {
    received.push(payload.text);
  });
  api.registerModifyingHook('before_prompt_build', async () => ({ appendSystem: 'rows' }));
  api.onCredentialUpdate((key) => {
    credentialUpdates.push(key);
  });
  api.registerMonitor({
    name: 'rows-monitor',
    run: async (_params, ctx) => {
      monitorRuns++;
      await ctx.notify({ sessionKey: 'cli:mon', message: 'from-monitor' });
      const token = await ctx.getSecret('token');
      ctx.emit('mon.event', { token });
      ctx.diagnostics?.info('monitor ran');
      const answer = ctx.llm ? await ctx.llm.complete('monitor prompt') : 'no-llm';
      ctx.emit('mon.llm', { answer });
      await ctx.kvStore.set('k', 'v');
      ctx.emit('mon.kv', { v: await ctx.kvStore.get('k') });
    },
  });

  const tool = (name, execute) => api.registerTool({ ...base, name, description: name, execute });
  tool('rows_value', async () =>
    text(
      JSON.stringify({
        pluginId: api.pluginId,
        baseUrl: api.getBaseUrl() ?? null,
        hasToken: api.hasSecret('token'),
        hasNope: api.hasSecret('nope'),
      }),
    ),
  );
  tool('rows_emit', async (args) => {
    api.emit(args.event, args.payload);
    return text('emitted');
  });
  tool('rows_emit_bad', async () => {
    const circular = {};
    circular.self = circular;
    api.emit('bad.event', circular);
    return text('emitted-bad');
  });
  tool('rows_on', async (args) => {
    api.on(args.event, (payload) => received.push({ event: args.event, payload }));
    return text('subscribed');
  });
  tool('rows_received', async () => text(JSON.stringify(received)));
  tool('rows_notify', async () => {
    await api.notify({ sessionKey: 'cli:notify', message: 'hello' });
    return text('notified');
  });
  tool('rows_diag', async () => {
    api.diagnostics.warn('diag warn', { a: 1 });
    api.diagnostics.metric('rows.metric', 3, { l: 'x' });
    return text('diag');
  });
  tool('rows_get_secret', async (args) => text(String(await api.getSecret(args.key))));
  tool('rows_set_secret', async (args) => {
    await api.setSecret(args.key, args.value);
    return text(JSON.stringify({ updates: credentialUpdates, has: api.hasSecret(args.key) }));
  });
  tool('rows_start_monitor', async () => {
    api.startMonitor('rows-monitor', {});
    await new Promise((r) => setTimeout(r, 400));
    return text(`runs=${monitorRuns}`);
  });
  tool('rows_stop_monitor', async () => {
    api.stopMonitor('rows-monitor');
    return text('stopped');
  });
}
