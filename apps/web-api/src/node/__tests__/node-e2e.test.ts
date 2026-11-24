// plan laptop-tool-node §7 (live smoke without an LLM key), brief D3: the whole feature over a REAL
// 127.0.0.1 socket. Server side: http server + createNodeLane + real SqliteApiKeyStore + NodeHub +
// proxy tools registered the way compose-tools does (registerNodeTools). Laptop side: real
// pairNode, NodeClient, NodeGuard (injected approval spy) and buildNodeExecutor over FsStorage.
// Steps run in order inside one describe; each waits on events. The one fixed wait is step 10's
// short window proving ABSENCE (no redial after 401): an event cannot prove a non-event.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultToolRegistry, makeTestToolContext } from '@ethosagent/core';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { createFileTools } from '@ethosagent/tools-file';
import type { ToolContext, ToolResult } from '@ethosagent/types';
import {
  buildNodeExecutor,
  NODE_FILE_TOOLS,
  NODE_HOST_SCOPE,
  NODE_TOOL_NAMES,
  NodeClient,
  type NodeClientStatus,
  NodeGuard,
  NodeHub,
  nodeCommandCheck,
  pairNode,
  registerNodeTools,
} from '@ethosagent/wiring/nodes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeLane } from '../node-lane';

let tmpHome: string;
let dataDir: string;
let proj: string;
let roDir: string;
let server: Server;
let base: string;
let store: SqliteApiKeyStore;
let hub: NodeHub;
let lane: ReturnType<typeof createNodeLane>;
let registry: DefaultToolRegistry;
let client: NodeClient | undefined;
let nodeKey = '';
let upgrades = 0;
const statuses: NodeClientStatus[] = [];
const approval = vi.fn(async () => true);
let executorCalls = 0;

const laptopCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  ...makeTestToolContext({ personalityId: 'laptop-hands', workingDir: '/srv/server' }),
  initiator: 'user',
  roomAudience: 'private',
  ...over,
});

let seq = 0;
async function call(
  name: string,
  args: unknown,
  opts: { allowed?: string[]; ctx?: ToolContext } = {},
): Promise<ToolResult> {
  seq += 1;
  const [res] = await registry.executeParallel(
    [{ toolCallId: `e2e-${seq}`, name, args }],
    opts.ctx ?? laptopCtx(),
    opts.allowed ?? [...NODE_TOOL_NAMES],
  );
  if (!res) throw new Error('no result');
  return res.result;
}
const errorOf = (r: ToolResult): string => (r.ok ? '' : r.error);

function startClient(key: string): NodeClient {
  const roots = [
    { path: proj, readOnly: false },
    { path: roDir, readOnly: true },
  ];
  const executor = buildNodeExecutor({
    roots,
    allowTerminal: false,
    storage: new FsStorage(),
    stateDir: join(tmpHome, '.ethos-laptop'),
  });
  const guard = new NodeGuard({
    policy: {
      roots,
      tools: [...NODE_FILE_TOOLS],
      personalities: ['*'],
      writes: 'ask',
      allowUnattended: false,
    },
    approve: approval,
    checkCommand: nodeCommandCheck,
  });
  const c = new NodeClient({
    url: base,
    key,
    hello: {
      name: 'ignored-by-server',
      roots,
      tools: [...executor.toolNames],
      personalities: ['*'],
    },
    guard,
    execute: (request, signal, emit) => {
      executorCalls += 1;
      return executor.execute(request, signal, emit);
    },
    onStatus: (s) => statuses.push(s),
  });
  c.start();
  return c;
}

const online = (): boolean => hub.list().some((n) => n.name === 'lap' && n.online);

beforeAll(async () => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'node-e2e-')));
  vi.stubEnv('HOME', tmpHome);
  dataDir = join(tmpHome, 'srv');
  proj = join(tmpHome, 'proj');
  roDir = join(tmpHome, 'ro');
  for (const d of [dataDir, proj, roDir, join(tmpHome, '.ssh')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'hello\n');
  writeFileSync(join(roDir, 'r.txt'), 'readonly\n');
  writeFileSync(join(tmpHome, '.ssh', 'id_rsa'), 'PRIVATE');
  symlinkSync(join(tmpHome, '.ssh'), join(proj, 'keys'));

  store = new SqliteApiKeyStore(join(dataDir, 'sessions.db'));
  hub = new NodeHub();
  lane = createNodeLane({ hub, apiKeys: store, pingIntervalMs: 50 });
  server = createServer();
  server.on('upgrade', (req) => {
    if (req.url?.startsWith('/node/ws')) upgrades += 1;
  });
  lane.socket.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  registry = new DefaultToolRegistry();
  registry.registerAll(createFileTools());
  // Four file proxies + node_list. The six-tool registration (with the terminal base) is pinned by
  // packages/wiring/src/__tests__/compose-tools-node.test.ts.
  expect(registerNodeTools(registry, hub)).toEqual([
    'node_read_file',
    'node_write_file',
    'node_patch_file',
    'node_search_files',
    'node_list',
  ]);
});

afterAll(async () => {
  await client?.stop();
  await lane?.close();
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  store?.close();
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('laptop tool node, end to end over a real socket', () => {
  it('1. pair -> approve -> key delivered once -> connect registers the node', async () => {
    let code = '';
    let approved: Promise<unknown> = Promise.resolve();
    const paired = await pairNode({
      url: base,
      name: 'lap',
      roots: [{ path: proj, readOnly: false }],
      onCode: (c) => {
        code = c;
        approved = lane.pairing.approve(c);
      },
    });
    await approved;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    nodeKey = paired.key;
    const rows = (await store.list()).filter((k) => k.name === 'node:lap');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scopes).toEqual([NODE_HOST_SCOPE]);
    // Delivered once: the code is spent.
    await expect(lane.pairing.approve(code)).resolves.toEqual({
      ok: false,
      reason: 'unknown_code',
    });

    client = startClient(nodeKey);
    await vi.waitFor(() => expect(online()).toBe(true), { timeout: 5000 });
    expect(statuses).toContain('connected');
    expect(hub.list()[0]?.name).toBe('lap');
  });

  it('2. node_read_file reads without approval; proxies are untrusted output', async () => {
    const r = await call('node_read_file', { path: 'a.txt' });
    expect(r.ok && r.value).toContain('hello');
    expect(approval).not.toHaveBeenCalled();
    expect(registry.get('node_read_file')?.outputIsUntrusted).toBe(true);
  });

  it('3. node_patch_file asks the laptop once, then the file changes', async () => {
    const r = await call('node_patch_file', {
      path: 'a.txt',
      old_text: 'hello',
      new_text: 'world',
    });
    expect(r.ok).toBe(true);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'write', personalityId: 'laptop-hands' }),
      expect.anything(),
    );
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('world\n');
  });

  it('4. a symlink out of the root is refused with no prompt', async () => {
    const before = approval.mock.calls.length;
    const r = await call('node_read_file', { path: 'keys/id_rsa' });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/PATH_NOT_REACHABLE|Filesystem boundary/);
    expect(approval.mock.calls.length).toBe(before);
  });

  it('5. a write into a :ro root is refused with no prompt and no change', async () => {
    const before = approval.mock.calls.length;
    const r = await call('node_write_file', { path: join(roDir, 'r.txt'), content: 'pwned' });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/PATH_NOT_REACHABLE|read-only/);
    expect(approval.mock.calls.length).toBe(before);
    expect(readFileSync(join(roDir, 'r.txt'), 'utf8')).toBe('readonly\n');
  });

  it('6. a personality without the tool in its toolset is not permitted (S1)', async () => {
    const r = await call('node_read_file', { path: 'a.txt' }, { allowed: ['read_file'] });
    expect(errorOf(r)).toContain('is not permitted for this personality');
  });

  it('7. a shared room is refused before the node executes anything', async () => {
    const before = executorCalls;
    const r = await call(
      'node_read_file',
      { path: 'a.txt' },
      { ctx: laptopCtx({ roomAudience: 'shared' }) },
    );
    expect(r.ok).toBe(false);
    expect(executorCalls).toBe(before);
  });

  it('8. node_list shows the node and its roots', async () => {
    const r = await call('node_list', {});
    const listed: unknown = r.ok ? JSON.parse(r.value) : [];
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'lap',
        online: true,
        roots: expect.arrayContaining([{ path: proj, readOnly: false }]),
      }),
    ]);
  });

  it('9. killing the node gives an immediate not_available "offline"', async () => {
    await client?.stop();
    await vi.waitFor(() => expect(online()).toBe(false), { timeout: 5000 });
    const t0 = Date.now();
    const r = await call('node_read_file', { path: 'a.txt', node: 'lap' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.ok === false && r.code).toBe('not_available');
    expect(errorOf(r)).toMatch(/offline \(last seen/);
    // Without `node`, the same call names the offline candidate instead of queueing.
    expect(errorOf(await call('node_read_file', { path: 'a.txt' }))).toMatch(
      /'lap' \(offline, last seen \d{4}-/,
    );
  });

  it('10. revoke closes the live socket (4401) and the client stops without redialling', async () => {
    statuses.length = 0;
    client = startClient(nodeKey);
    await vi.waitFor(() => expect(online()).toBe(true), { timeout: 5000 });
    const row = (await store.list()).find((k) => k.name === 'node:lap' && !k.revokedAt);
    if (!row) throw new Error('no live node key');
    await store.revoke(row.prefix);
    await vi.waitFor(() => expect(statuses).toContain('unauthorized'), { timeout: 8000 });
    // The 4401 close is the 401 twin: straight to unauthorized, no reconnect round trip.
    expect(statuses).not.toContain('disconnected');
    expect(client.status).toBe('unauthorized');
    expect(online()).toBe(false);
    const dialled = upgrades;
    // A bounded window proving absence: the 4401 branch of NodeClient.onClose arms no redial timer.
    await new Promise((r) => setTimeout(r, 200));
    expect(upgrades).toBe(dialled);
  });
});
