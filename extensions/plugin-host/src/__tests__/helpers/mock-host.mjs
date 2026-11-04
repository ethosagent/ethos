// A protocol-speaking stand-in for a plugin host, used to drive failure paths
// deterministically (and fast: no tsx, no plugin load). Mode comes from MOCK_MODE.
import { createInterface } from 'node:readline';

const mode = process.env.MOCK_MODE ?? 'ok';
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const voidHook = { kind: 'hook', model: 'void', name: 'agent_done' };
const tool = {
  kind: 'tool',
  name: 't',
  description: 'mock',
  schema: { type: 'object', properties: {} },
  capabilities: {},
  available: true,
};

if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  send({ method: 'ethos/ready', params: { protocolVersion: 1, pid: process.pid } });
  if (mode === 'garbage') process.stdout.write('this is not json\n');
  if (mode === 'oversize') process.stdout.write(`${'x'.repeat(9 * 1024 * 1024)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'ethos/activate':
      send({ id: msg.id, result: { registrations: [tool, voidHook], holdsLongLived: false } });
      if (mode === 'dup') {
        send({ id: msg.id, result: { registrations: [], holdsLongLived: false } });
        send({ id: 9999, result: null });
      }
      break;
    case 'ethos/ping':
      if (mode !== 'noping') send({ id: msg.id, result: { tools: { t: true } } });
      break;
    case 'ethos/shutdown':
      if (mode !== 'stubborn') {
        send({ id: msg.id, result: null });
        setTimeout(() => process.exit(0), 10);
      }
      break;
    case 'ethos/hook.fire':
      if (mode === 'slowhook') setTimeout(() => send({ id: msg.id, result: null }), 300);
      else send({ id: msg.id, result: null });
      break;
    case 'ethos/tool.execute':
      if (msg.params.request.args?.die) process.exit(1);
      if (msg.params.request.args?.hang) break;
      send({ id: msg.id, result: { ok: true, value: 'mock-ok' } });
      break;
    default:
      send({ id: msg.id, result: null });
  }
});
