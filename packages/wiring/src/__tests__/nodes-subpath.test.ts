/** `@ethosagent/wiring/nodes` (plan laptop-tool-node B5, verification B8 / D-STATE). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultToolRegistry } from '@ethosagent/core';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FileSecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { createFileTools } from '@ethosagent/tools-file';
import { createTerminalTools } from '@ethosagent/tools-terminal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listNodeKeys,
  NODE_TOOL_NAMES,
  NodeHub,
  type NodeState,
  nodeKeyRef,
  processNodeHub,
  readNodeState,
  registerNodeTools,
  resetProcessNodeHubForTests,
  revokeNodeKeys,
  writeNodeState,
} from '../nodes';

afterEach(() => resetProcessNodeHubForTests());

const state: NodeState = {
  server: 'https://ethos.example.com',
  name: 'lap',
  roots: [
    { path: '/Users/me/code', readOnly: false },
    { path: '/Users/me/docs', readOnly: true },
  ],
  personalities: ['*'],
  allowTerminal: false,
  writes: 'ask',
  allowUnattended: false,
};

describe('wiring/nodes', () => {
  it('registerNodeTools registers exactly NODE_TOOL_NAMES', () => {
    const registry = new DefaultToolRegistry();
    registry.registerAll([...createFileTools(), ...createTerminalTools()]);
    const names = registerNodeTools(registry, new NodeHub());
    expect([...names].sort()).toEqual([...NODE_TOOL_NAMES]);
    for (const n of NODE_TOOL_NAMES) expect(registry.get(n)).toBeDefined();
  });

  it('skips a missing base tool', () => {
    const registry = new DefaultToolRegistry();
    registry.registerAll(createFileTools());
    const names = registerNodeTools(registry, new NodeHub());
    expect(names).not.toContain('node_terminal');
    expect(names).toContain('node_list');
  });

  it('nodeKeyRef passes FileSecretsResolver validation', async () => {
    const resolver = new FileSecretsResolver({ dir: '/secrets', storage: new InMemoryStorage() });
    for (const url of ['https://a.b:8443', 'http://127.0.0.1:3000']) {
      const ref = nodeKeyRef(url);
      expect(ref).toMatch(/^nodes\/[A-Za-z0-9_-]+\/key$/);
      await resolver.set(ref, 'k');
      await expect(resolver.get(ref)).resolves.toBe('k');
    }
  });

  it('round-trips node state and returns null for malformed JSON', async () => {
    const storage = new InMemoryStorage();
    await expect(readNodeState(storage, '/state')).resolves.toBeNull();
    await writeNodeState(storage, '/state', state);
    await expect(readNodeState(storage, '/state')).resolves.toEqual(state);
    await storage.write('/state/node/node.json', '{not json');
    await expect(readNodeState(storage, '/state')).resolves.toBeNull();
    await storage.write('/state/node/node.json', JSON.stringify({ ...state, writes: 'maybe' }));
    await expect(readNodeState(storage, '/state')).resolves.toBeNull();
  });

  it('processNodeHub is a singleton', () => {
    expect(processNodeHub()).toBe(processNodeHub());
  });

  describe('operator key helpers (brief D1)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ethos-node-keys-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    async function seed(): Promise<void> {
      const store = new SqliteApiKeyStore(join(dir, 'sessions.db'));
      try {
        await store.create({ name: 'node:lap', scopes: ['node:host'] });
        await store.create({ name: 'node:lap', scopes: ['node:host'] });
        await store.create({ name: 'node:desk', scopes: ['node:host'] });
        await store.create({ name: 'chat-key', scopes: ['chat'] });
      } finally {
        store.close();
      }
    }

    it('listNodeKeys returns only live node:<name> keys', async () => {
      await seed();
      const keys = await listNodeKeys(dir);
      expect(keys.map((k) => k.name).sort()).toEqual(['desk', 'lap', 'lap']);
      expect(keys[0]?.prefix).toMatch(/^sk-ethos-/);
      expect(keys[0]?.lastUsed).toBeNull();
      expect(Number.isNaN(Date.parse(keys[0]?.createdAt ?? ''))).toBe(false);
    });

    it('revokeNodeKeys revokes every live key of that name and reports the count', async () => {
      await seed();
      await expect(revokeNodeKeys(dir, 'lap')).resolves.toBe(2);
      expect((await listNodeKeys(dir)).map((k) => k.name)).toEqual(['desk']);
      await expect(revokeNodeKeys(dir, 'lap')).resolves.toBe(0);
      await expect(revokeNodeKeys(dir, 'ghost')).resolves.toBe(0);
      // A non-node key is never touched.
      await expect(revokeNodeKeys(dir, 'chat-key')).resolves.toBe(0);
    });
  });
});
