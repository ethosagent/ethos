// Reports which ToolContext keys exist in the host and exercises each reverse handle.
const KEYS = [
  'sessionId',
  'sessionKey',
  'platform',
  'workingDir',
  'agentId',
  'rootSessionKey',
  'jobId',
  'reviewOfJobId',
  'roomAudience',
  'initiator',
  'toolsetNarrowing',
  'origin',
  'toolCallId',
  'personalityId',
  'memoryScopeId',
  'userScopeId',
  'teamId',
  'currentTurn',
  'messageCount',
  'networkPolicy',
  'dryRun',
  'abortSignal',
  'emit',
  'storage',
  'readMtimes',
  'a2aDelegation',
  'scriptTools',
  'llm',
  'getContext',
  'setContext',
  'kvStore',
  'secretsResolver',
  'scopedFetch',
  'scopedFs',
  'scopedProcess',
  'attachments',
  'resultBudgetChars',
];
const stash = {};

export function activate(api) {
  api.registerTool({
    name: 'ctx_probe',
    description: 'ctx probe',
    schema: { type: 'object', properties: {} },
    capabilities: {
      network: { allowedHosts: ['example.com'] },
      secrets: ['plugins/ctxprobe/token'],
      storage: { scope: 'tool-private', kind: 'kv' },
      fs_reach: { read: ['/'] },
      attachments: { kinds: '*' },
      process: { allowedBinaries: ['node'] },
    },
    execute: async (_args, ctx) => {
      stash.ctx = ctx;
      const present = {};
      for (const k of KEYS) present[k] = ctx[k] !== undefined;
      const out = { present, wire: {}, calls: {} };
      for (const k of [
        'sessionId',
        'personalityId',
        'workingDir',
        'currentTurn',
        'toolCallId',
        'origin',
        'resultBudgetChars',
      ])
        out.wire[k] = ctx[k];
      out.calls.storage = await ctx.storage.read('/probe/file');
      await ctx.kvStore.set('a', 'b');
      out.calls.kv = await ctx.kvStore.get('a');
      out.calls.secret = await ctx.secretsResolver.get('plugins/ctxprobe/token');
      const res = await ctx.scopedFetch.fetch('https://example.com/x', {
        method: 'POST',
        headers: { 'x-a': 'b' },
        body: 'payload',
      });
      out.calls.fetch = {
        status: res.status,
        text: await res.text(),
        header: res.headers.get('x-reply'),
      };
      out.calls.fs = await ctx.scopedFs.read('/probe/fs');
      out.calls.llm = await ctx.llm.complete('prompt', { maxTokens: 7 });
      const listed = ctx.attachments.list();
      out.calls.attachmentList = listed.map((a) => a.ref);
      const opened = await ctx.attachments.open(listed[0]);
      out.calls.attachmentPath = opened.path;
      const { readFileSync } = await import('node:fs');
      out.calls.attachmentBytes = readFileSync(opened.path, 'utf8');
      ctx.emit({ type: 'progress', toolName: 'ctx_probe', message: 'working', audience: 'user' });
      const proc = await ctx.scopedProcess.spawn('node', [
        '-e',
        'process.stdout.write(process.env.HOME ?? "")',
      ]);
      out.calls.processHome = proc.stdout;
      return { ok: true, value: JSON.stringify(out) };
    },
  });
  api.registerTool({
    name: 'ctx_bare',
    description: 'a tool that declares nothing',
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async (_args, ctx) => ({
      ok: true,
      value: JSON.stringify(
        Object.fromEntries(
          [
            'kvStore',
            'secretsResolver',
            'scopedFetch',
            'scopedFs',
            'scopedProcess',
            'attachments',
            'llm',
            'storage',
          ].map((k) => [k, ctx[k] !== undefined]),
        ),
      ),
    }),
  });
  api.registerTool({
    name: 'ctx_keep',
    description:
      'keeps the context of the previous probe call and uses it after that call returned',
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async () => {
      try {
        return { ok: true, value: `used:${await stash.ctx.storage.read('/probe/file')}` };
      } catch (err) {
        return { ok: true, value: `refused:${err.message}` };
      }
    },
  });
}
