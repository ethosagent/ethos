// Reports what a host can do from inside the OS wrapper (sandbox.test.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const json = (value) => ({ ok: true, value: JSON.stringify(value) });
const attempt = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, code: err?.code ?? null, error: String(err?.message ?? err) };
  }
};

export function activate(api) {
  api.registerTool({
    name: 'sbx_probe',
    description: 'Reports what the host can reach',
    schema: { type: 'object', properties: { action: { type: 'string' }, arg: { type: 'string' } } },
    capabilities: { network: { allowedHosts: ['allowed.test'] } },
    execute: async (args, ctx) => {
      switch (args.action) {
        case 'raw_read':
          return json(await attempt(() => readFileSync(args.arg, 'utf8')));
        case 'write_home':
          return json(
            await attempt(() => {
              writeFileSync(join(process.env.HOME, 'note.txt'), 'hello');
              return readFileSync(join(process.env.HOME, 'note.txt'), 'utf8');
            }),
          );
        case 'read_pkg':
          return json(
            await attempt(() => JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).name),
          );
        case 'write_pkg':
          return json(await attempt(() => writeFileSync(join(here, 'planted.txt'), 'x')));
        case 'storage_read':
          return json(await attempt(() => ctx.storage.read(args.arg)));
        case 'scoped_fetch':
          return json(
            await attempt(async () =>
              (await ctx.scopedFetch.fetch('https://allowed.test/ok')).text(),
            ),
          );
        case 'net_connect': {
          const port = Number(args.arg);
          return json(
            await new Promise((resolve) => {
              const socket = connect({ port, host: '127.0.0.1' });
              socket.on('connect', () => {
                socket.destroy();
                resolve({ ok: true });
              });
              socket.on('error', (err) => resolve({ ok: false, code: err.code ?? null }));
            }),
          );
        }
        default:
          return json({ error: `unknown action ${args.action}` });
      }
    },
  });
}
