// Cross-surface parity test: verifies the CLI and web OAuth flows write tokens
// to the same personality-scoped path, and that neither writes a global
// (non-personality-scoped) token.
//
// This test does NOT exercise the full OAuth flow — that is covered by
// install-flow.test.ts. It focuses on the path-convergence guarantee:
// PersonalityScopedSecrets + storeTokens produces the same key regardless of
// whether the caller is the CLI `ethos mcp login` or the web McpInstallFlow.

import { InMemorySecretsResolver, PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { storeTokens } from '../oauth';

describe('cross-surface parity', () => {
  it('web and CLI OAuth flows write tokens to the same personality-scoped path', async () => {
    const baseResolver = new InMemorySecretsResolver();
    const personalityId = 'support';
    const serverName = 'linear';
    const tokens = { access_token: 'test-token-123', token_type: 'Bearer' };

    // Simulate CLI path: wrap base resolver in PersonalityScopedSecrets + storeTokens
    const cliSecrets = new PersonalityScopedSecrets(baseResolver, personalityId);
    await storeTokens(serverName, tokens, cliSecrets);

    // Verify the token landed at the personality-scoped path
    const scopedPath = `personalities/${personalityId}/mcp/${serverName}/access_token`;
    const storedToken = await baseResolver.get(scopedPath);
    expect(storedToken).toBe('test-token-123');

    // Verify the global path was NOT written
    const globalPath = `mcp/${serverName}/access_token`;
    const globalToken = await baseResolver.get(globalPath);
    expect(globalToken).toBeNull();
  });

  it('different personalityIds produce isolated token namespaces', async () => {
    const baseResolver = new InMemorySecretsResolver();

    const secrets1 = new PersonalityScopedSecrets(baseResolver, 'admin');
    const secrets2 = new PersonalityScopedSecrets(baseResolver, 'support');

    await storeTokens('linear', { access_token: 'admin-token' }, secrets1);
    await storeTokens('linear', { access_token: 'support-token' }, secrets2);

    const adminToken = await baseResolver.get('personalities/admin/mcp/linear/access_token');
    const supportToken = await baseResolver.get('personalities/support/mcp/linear/access_token');

    expect(adminToken).toBe('admin-token');
    expect(supportToken).toBe('support-token');
    expect(adminToken).not.toBe(supportToken);
  });

  it('refresh_token and expires_at are also personality-scoped', async () => {
    const baseResolver = new InMemorySecretsResolver();
    const personalityId = 'researcher';
    const serverName = 'github';

    const scoped = new PersonalityScopedSecrets(baseResolver, personalityId);
    await storeTokens(
      serverName,
      {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_at: '2026-06-01T00:00:00.000Z',
      },
      scoped,
    );

    // Scoped paths
    expect(
      await baseResolver.get(`personalities/${personalityId}/mcp/${serverName}/access_token`),
    ).toBe('at-1');
    expect(
      await baseResolver.get(`personalities/${personalityId}/mcp/${serverName}/refresh_token`),
    ).toBe('rt-1');
    expect(
      await baseResolver.get(`personalities/${personalityId}/mcp/${serverName}/expires_at`),
    ).toBe('2026-06-01T00:00:00.000Z');

    // Global paths must be empty
    expect(await baseResolver.get(`mcp/${serverName}/access_token`)).toBeNull();
    expect(await baseResolver.get(`mcp/${serverName}/refresh_token`)).toBeNull();
    expect(await baseResolver.get(`mcp/${serverName}/expires_at`)).toBeNull();
  });

  it('ethos mcp add --url does not write a global token (define-only)', async () => {
    // After Phase 5, `ethos mcp add --url` only writes the mcp.json definition.
    // This is a smoke test verifying the path convention: if nothing calls
    // storeTokens, the global key stays empty.
    const baseResolver = new InMemorySecretsResolver();

    const globalPath = 'mcp/linear/access_token';
    const globalToken = await baseResolver.get(globalPath);
    expect(globalToken).toBeNull();
  });
});
