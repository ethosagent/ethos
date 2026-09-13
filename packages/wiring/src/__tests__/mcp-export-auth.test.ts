// M-T3 — `createMcpClientAuthenticator`, the per-client bearer check an MCP
// export runs at initialize AND on every call (M-D9,
// plan/phases/trust-before-reach.md Part 3).
//
// Driven against the REAL `SqliteApiKeyStore` on a temp file, because the two
// guarantees being made are the store's: that `findByHash` never returns a
// revoked row, and that the hash the check computes is the one `create()`
// wrote. A fake store would assert them about itself.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpClientAuthenticator, type McpApiKeyStoreView } from '../mcp-export';

let dir: string;
let store: SqliteApiKeyStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-mcp-export-auth-'));
  store = new SqliteApiKeyStore(join(dir, 'sessions.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => createMcpClientAuthenticator({ personalityId: 'reviewer', keys: store });

describe('createMcpClientAuthenticator', () => {
  it('names the scope a key must carry', () => {
    expect(auth().requiredScope).toBe('mcp:reviewer');
  });

  it('accepts a key scoped mcp:<id> for this personality', async () => {
    const { secret, record } = await store.create({
      name: 'claude-desktop',
      scopes: ['mcp:reviewer'],
    });
    const result = await auth().verify(secret);
    if (!result.ok) throw new Error(`expected accept, got ${result.reason}`);
    expect(result.keyId).toBe(record.id);
    expect(result.keyPrefix).toBe(record.prefix);
    expect(result.keyName).toBe('claude-desktop');
    // The audit + session-key identity (M-D8). No `:`, so a client cannot
    // widen its own session-key prefix.
    expect(result.clientId).toBe(`key-${record.prefix}`);
    expect(result.clientId).not.toContain(':');
  });

  it('touches last_used on an accepted key', async () => {
    const { secret, record } = await store.create({ name: 'k', scopes: ['mcp:reviewer'] });
    expect(record.lastUsed).toBeNull();
    await auth().verify(secret);
    const listed = (await store.list()).find((r) => r.id === record.id);
    expect(listed?.lastUsed).toBeInstanceOf(Date);
  });

  it('refuses a REVOKED key — no restart needed, the next call is already denied', async () => {
    const { secret, record } = await store.create({ name: 'k', scopes: ['mcp:reviewer'] });
    expect((await auth().verify(secret)).ok).toBe(true);
    await store.revoke(record.prefix);
    const after = await auth().verify(secret);
    expect(after).toEqual({ ok: false, reason: 'invalid_key' });
  });

  it('refuses a key scoped to ANOTHER export — one client is not a key to the machine', async () => {
    const { secret } = await store.create({ name: 'other', scopes: ['mcp:other'] });
    expect(await auth().verify(secret)).toEqual({ ok: false, reason: 'wrong_scope' });
  });

  it('refuses a key scoped to a different SURFACE', async () => {
    const { secret } = await store.create({
      name: 'cursor',
      scopes: ['chat', 'sessions:read'],
    });
    expect(await auth().verify(secret)).toEqual({ ok: false, reason: 'wrong_scope' });
  });

  it('accepts a key carrying mcp:<id> alongside other scopes', async () => {
    const { secret } = await store.create({
      name: 'mixed',
      scopes: ['chat', 'mcp:reviewer'],
    });
    expect((await auth().verify(secret)).ok).toBe(true);
  });

  it('refuses an unknown key', async () => {
    expect(await auth().verify('sk-ethos-deadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'invalid_key',
    });
  });

  it('refuses a missing or empty key without touching the store', async () => {
    let looked = 0;
    const counting: McpApiKeyStoreView = {
      findByHash: async () => {
        looked++;
        return null;
      },
      touchLastUsed: async () => {},
    };
    const a = createMcpClientAuthenticator({ personalityId: 'reviewer', keys: counting });
    expect(await a.verify(undefined)).toEqual({ ok: false, reason: 'missing_key' });
    expect(await a.verify('   ')).toEqual({ ok: false, reason: 'missing_key' });
    expect(await a.verify('not-an-ethos-key')).toEqual({ ok: false, reason: 'malformed_key' });
    expect(looked).toBe(0);
  });

  it('still accepts when the last_used write throws — metadata never refuses a caller', async () => {
    const { secret } = await store.create({ name: 'k', scopes: ['mcp:reviewer'] });
    const flaky: McpApiKeyStoreView = {
      findByHash: (hash) => store.findByHash(hash),
      touchLastUsed: async () => {
        throw new Error('db is locked');
      },
    };
    const result = await createMcpClientAuthenticator({
      personalityId: 'reviewer',
      keys: flaky,
    }).verify(secret);
    expect(result.ok).toBe(true);
  });
});
