import { describe, expect, it } from 'vitest';
import { PersonalityScopedSecrets } from '../personality-scoped-secrets';
import { InMemorySecretsResolver } from '../secrets';

describe('PersonalityScopedSecrets', () => {
  it('get/set/delete round-trip through scope prefix', async () => {
    const inner = new InMemorySecretsResolver();
    const scoped = new PersonalityScopedSecrets(inner, 'researcher');
    await scoped.set('mcp/linear/access_token', 'tok-abc');
    expect(await scoped.get('mcp/linear/access_token')).toBe('tok-abc');
    expect(await inner.get('personalities/researcher/mcp/linear/access_token')).toBe('tok-abc');
    await scoped.delete('mcp/linear/access_token');
    expect(await scoped.get('mcp/linear/access_token')).toBeNull();
    expect(await inner.get('personalities/researcher/mcp/linear/access_token')).toBeNull();
  });
  it('list(prefix) strips the scope correctly', async () => {
    const inner = new InMemorySecretsResolver();
    const scoped = new PersonalityScopedSecrets(inner, 'coder');
    await scoped.set('mcp/github/access_token', 'gh-tok');
    await scoped.set('mcp/github/refresh_token', 'gh-ref');
    await scoped.set('mcp/linear/access_token', 'ln-tok');
    const githubRefs = await scoped.list('mcp/github/');
    expect(githubRefs.sort()).toEqual(['mcp/github/access_token', 'mcp/github/refresh_token']);
    const allMcpRefs = await scoped.list('mcp/');
    expect(allMcpRefs.sort()).toEqual([
      'mcp/github/access_token',
      'mcp/github/refresh_token',
      'mcp/linear/access_token',
    ]);
  });
  it('two personalities sharing a server have distinct refs', async () => {
    const inner = new InMemorySecretsResolver();
    const alice = new PersonalityScopedSecrets(inner, 'alice');
    const bob = new PersonalityScopedSecrets(inner, 'bob');
    await alice.set('mcp/linear/access_token', 'alice-token');
    await bob.set('mcp/linear/access_token', 'bob-token');
    expect(await alice.get('mcp/linear/access_token')).toBe('alice-token');
    expect(await bob.get('mcp/linear/access_token')).toBe('bob-token');
    expect(await inner.get('personalities/alice/mcp/linear/access_token')).toBe('alice-token');
    expect(await inner.get('personalities/bob/mcp/linear/access_token')).toBe('bob-token');
    await alice.delete('mcp/linear/access_token');
    expect(await alice.get('mcp/linear/access_token')).toBeNull();
    expect(await bob.get('mcp/linear/access_token')).toBe('bob-token');
  });
  it('list() with no prefix returns all refs under the personality namespace', async () => {
    const inner = new InMemorySecretsResolver();
    const scoped = new PersonalityScopedSecrets(inner, 'researcher');
    await scoped.set('mcp/linear/access_token', 'lt');
    await scoped.set('mcp/github/access_token', 'gt');
    await scoped.set('api/key', 'ak');
    await inner.set('personalities/other/mcp/linear/access_token', 'other-lt');
    await inner.set('global/unscoped', 'global-val');
    const refs = await scoped.list();
    expect(refs.sort()).toEqual(['api/key', 'mcp/github/access_token', 'mcp/linear/access_token']);
  });
  it('get returns null for refs not in the personality namespace', async () => {
    const inner = new InMemorySecretsResolver();
    const scoped = new PersonalityScopedSecrets(inner, 'researcher');
    await inner.set('mcp/linear/access_token', 'global-tok');
    expect(await scoped.get('mcp/linear/access_token')).toBeNull();
  });
  it('scoped login tokens are readable by a second scoped instance and isolated from other personalities and the bare resolver', async () => {
    const inner = new InMemorySecretsResolver();
    // 1. "support" personality stores OAuth tokens via the standard ref pattern
    const supportWriter = new PersonalityScopedSecrets(inner, 'support');
    await supportWriter.set('mcp/linear/access_token', 'support-access');
    await supportWriter.set('mcp/linear/refresh_token', 'support-refresh');
    await supportWriter.set('mcp/linear/expires_at', '1716300000');
    // 2. A second instance for the same personality reads them back
    const supportReader = new PersonalityScopedSecrets(inner, 'support');
    expect(await supportReader.get('mcp/linear/access_token')).toBe('support-access');
    expect(await supportReader.get('mcp/linear/refresh_token')).toBe('support-refresh');
    expect(await supportReader.get('mcp/linear/expires_at')).toBe('1716300000');
    // 3. A different personality does NOT see support's tokens
    const admin = new PersonalityScopedSecrets(inner, 'admin');
    expect(await admin.get('mcp/linear/access_token')).toBeNull();
    expect(await admin.get('mcp/linear/refresh_token')).toBeNull();
    expect(await admin.get('mcp/linear/expires_at')).toBeNull();
    // 4. The bare (unscoped) inner resolver does NOT see the tokens at the unscoped path
    expect(await inner.get('mcp/linear/access_token')).toBeNull();
    expect(await inner.get('mcp/linear/refresh_token')).toBeNull();
    expect(await inner.get('mcp/linear/expires_at')).toBeNull();
  });
});
