/**
 * `@ethosagent/wiring/nodes` — the app-facing surface of the laptop tool node (plan
 * laptop-tool-node, verification B3/B8). Apps may not import extensions, so web-api and the CLI
 * reach `@ethosagent/execution-node` through this subpath.
 */

import { join } from 'node:path';
import {
  createNodeListTool,
  createNodeProxyTool,
  decodeRoots,
  isRecord,
  isStringArray,
  NODE_BASE_TOOLS,
  NodeHub,
  type NodeRoot,
} from '@ethosagent/execution-node';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import type { Logger, Storage, Tool, ToolRegistry } from '@ethosagent/types';

export * from '@ethosagent/execution-node';
export { checkCommand as nodeCommandCheck } from '@ethosagent/tools-terminal';
export { buildNodeExecutor, type NodeExecutor, type NodeExecutorOptions } from './node-executor';

/** The six proxy names, sorted. */
export const NODE_TOOL_NAMES: readonly string[] = [
  ...NODE_BASE_TOOLS.map((n) => `node_${n}`),
  'node_list',
].sort();

let hub: NodeHub | undefined;

/**
 * The process's one NodeHub (verification B8). compose-tools and buildServeWebApi both read it.
 * The first call creates the hub with its logger (D16 eviction log); later loggers are ignored.
 */
export function processNodeHub(logger?: Logger): NodeHub {
  hub ??= new NodeHub(logger ? { logger } : {});
  return hub;
}

export function resetProcessNodeHubForTests(): void {
  hub = undefined;
}

/** Registers node_read_file … node_terminal + node_list from the LIVE base tools in `registry`. Missing base → skipped. */
export function registerNodeTools(registry: ToolRegistry, nodeHub: NodeHub): string[] {
  const registered: string[] = [];
  for (const name of NODE_BASE_TOOLS) {
    const base: Tool | undefined = registry.get(name);
    if (!base) continue;
    const proxy = createNodeProxyTool(base, nodeHub);
    registry.register(proxy);
    registered.push(proxy.name);
  }
  const list = createNodeListTool(nodeHub);
  registry.register(list);
  registered.push(list.name);
  return registered;
}

/** SecretRef for a server's node key: `nodes/<slug>/key` (verification D-STATE). */
export function nodeKeyRef(serverUrl: string): string {
  let hostPort = serverUrl;
  try {
    hostPort = new URL(serverUrl).host;
  } catch {
    // Not a URL: slug the raw text instead; validateRef still gets a safe string.
  }
  const slug = hostPort.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
  return `nodes/${slug}/key`;
}

export interface NodeState {
  server: string;
  name: string;
  roots: NodeRoot[];
  personalities: string[];
  allowTerminal: boolean;
  writes: 'ask' | 'auto';
  allowUnattended: boolean;
}

const statePath = (stateDir: string) => join(stateDir, 'node', 'node.json');

function parseNodeState(value: unknown): NodeState | null {
  if (!isRecord(value)) return null;
  const { server, name, roots, personalities, allowTerminal, writes, allowUnattended } = value;
  if (typeof server !== 'string' || typeof name !== 'string') return null;
  const outRoots = decodeRoots(roots);
  if (outRoots === null || !Array.isArray(personalities)) return null;
  if (typeof allowTerminal !== 'boolean' || typeof allowUnattended !== 'boolean') return null;
  if (writes !== 'ask' && writes !== 'auto') return null;
  if (!isStringArray(personalities)) return null;
  return {
    server,
    name,
    roots: outRoots,
    personalities: [...personalities],
    allowTerminal,
    writes,
    allowUnattended,
  };
}

export async function readNodeState(storage: Storage, stateDir: string): Promise<NodeState | null> {
  const text = await storage.read(statePath(stateDir));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Corrupt state is treated as absent: the caller re-runs `ethos node connect`.
    return null;
  }
  return parseNodeState(parsed);
}

export async function writeNodeState(
  storage: Storage,
  stateDir: string,
  state: NodeState,
): Promise<void> {
  const path = statePath(stateDir);
  await storage.mkdir(join(stateDir, 'node'));
  await storage.writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

const NODE_KEY_PREFIX = 'node:';

/** Live (non-revoked) `node:<name>` keys in `<dataDir>/sessions.db`. Pinned by nodes-subpath.test.ts. */
export async function listNodeKeys(
  dataDir: string,
): Promise<Array<{ name: string; prefix: string; createdAt: string; lastUsed: string | null }>> {
  const store = new SqliteApiKeyStore(join(dataDir, 'sessions.db'));
  try {
    return (await store.list())
      .filter((k) => k.name.startsWith(NODE_KEY_PREFIX) && !k.revokedAt)
      .map((k) => ({
        name: k.name.slice(NODE_KEY_PREFIX.length),
        prefix: k.prefix,
        createdAt: k.createdAt.toISOString(),
        lastUsed: k.lastUsed ? k.lastUsed.toISOString() : null,
      }));
  } finally {
    store.close();
  }
}

/**
 * Revoke every live key named `node:<name>`; returns how many. The live socket closes on its next
 * ping tick (apps/web-api/src/node/node-socket.ts re-validates; pinned by node-socket.test.ts).
 */
export async function revokeNodeKeys(dataDir: string, name: string): Promise<number> {
  const store = new SqliteApiKeyStore(join(dataDir, 'sessions.db'));
  try {
    let n = 0;
    for (const k of await store.list()) {
      if (
        k.name === `${NODE_KEY_PREFIX}${name}` &&
        !k.revokedAt &&
        (await store.revoke(k.prefix))
      ) {
        n += 1;
      }
    }
    return n;
  } finally {
    store.close();
  }
}
