import { InMemorySessionStore } from '@ethosagent/core';
import Database from '@ethosagent/sqlite';
import type { SessionStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteApiKeyStore } from '../api-key-store';
import { SQLiteSessionStore } from '../index';
import { SqliteKeyValueStore } from '../kv-store';

// Every key-prefix filter is a literal, case-sensitive prefix. SQLite's LIKE
// folds ASCII case and reads `%`/`_` as wildcards, so a LIKE prefix mixed
// `telegram:Sales:` with `telegram:sales:` sessions. Run against BOTH shipped
// session stores so the in-memory store cannot drift from the SQLite one.

const base = {
  platform: 'telegram',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

const KEYS = [
  'telegram:Sales:c1',
  'telegram:sales:c1',
  'telegram:SALES:c1',
  'telegram:a%b_c:c1',
  'telegram:aXbYc:c1',
  'telegram:a%bYc:c1',
];

const factories: Array<{ name: string; make(): { store: SessionStore; close(): void } }> = [
  {
    name: 'SQLiteSessionStore',
    make: () => {
      const store = new SQLiteSessionStore(':memory:');
      return { store, close: () => store.close() };
    },
  },
  { name: 'InMemorySessionStore', make: () => ({ store: new InMemorySessionStore(), close() {} }) },
];

for (const factory of factories) {
  describe(`listSessions keyPrefix is a literal, case-sensitive prefix: ${factory.name}`, () => {
    let store: SessionStore;
    let close: () => void;

    beforeEach(async () => {
      ({ store, close } = factory.make());
      for (const key of KEYS) await store.createSession({ ...base, key } as never);
    });
    afterEach(() => close());

    const keysFor = async (keyPrefix: string) =>
      (await store.listSessions({ keyPrefix })).map((s) => s.key).sort();

    it('Sales and sales are different bots', async () => {
      expect(await keysFor('telegram:Sales:')).toEqual(['telegram:Sales:c1']);
      expect(await keysFor('telegram:sales:')).toEqual(['telegram:sales:c1']);
    });

    it('% and _ in a prefix match only themselves', async () => {
      expect(await keysFor('telegram:a%b_c:')).toEqual(['telegram:a%b_c:c1']);
    });
  });
}

describe('SQLiteSessionStore excludeKeyPrefixes is literal and case-sensitive', () => {
  it('excludes only the exact prefix', async () => {
    const store = new SQLiteSessionStore(':memory:');
    for (const key of KEYS) await store.createSession({ ...base, key } as never);
    const keys = (
      await store.listSessions({ excludeKeyPrefixes: ['telegram:sales:', 'telegram:a%b_c:'] })
    )
      .map((s) => s.key)
      .sort();
    expect(keys).toEqual(
      ['telegram:SALES:c1', 'telegram:Sales:c1', 'telegram:a%bYc:c1', 'telegram:aXbYc:c1'].sort(),
    );
    store.close();
  });
});

describe('SqliteKeyValueStore.list prefix is case-sensitive', () => {
  it('lists only keys with the exact prefix', async () => {
    const db = new Database(':memory:');
    SqliteKeyValueStore.migrate(db);
    const kv = new SqliteKeyValueStore(db, 'tool', 'scope');
    for (const key of ['Sales:1', 'sales:1', 'a%b_c:1', 'aXbYc:1']) await kv.set(key, 'v');
    expect((await kv.list('sales:')).sort()).toEqual(['sales:1']);
    expect((await kv.list('a%b_c:')).sort()).toEqual(['a%b_c:1']);
    db.close();
  });
});

describe('SqliteApiKeyStore.revoke prefix is literal and case-sensitive', () => {
  it('an upper-cased or wildcard prefix revokes nothing', async () => {
    const store = new SqliteApiKeyStore(':memory:');
    const { record } = await store.create({ name: 'a', scopes: ['chat'] });
    expect(await store.revoke(record.prefix.toUpperCase())).toBeNull();
    expect(await store.revoke('sk_ethos')).toBeNull();
    expect((await store.revoke(record.prefix))?.id).toBe(record.id);
    store.close();
  });
});
