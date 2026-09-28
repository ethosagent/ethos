// V-CC-4 follow-up — the adapter classifies its own start failures. A login
// discord.js refuses for a bad token or a disallowed intent is thrown with
// `permanent: true`, so the gateway's adapter-start retry
// (`isPermanentAdapterStartError`, apps/ethos/src/commands/gateway.ts) stops
// instead of retrying a dead token for ever. Anything else is thrown as-is.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../index';
import { loadDiscordSdk } from '../sdk';

function adapterWhoseLoginRejects(err: unknown) {
  const adapter = new DiscordAdapter({ token: 'fake-token', botKey: 'test-bot' });
  const login = vi.fn().mockRejectedValue(err);
  (adapter as unknown as { client: unknown }).client = { on: () => {}, login };
  return { adapter, login };
}

describe('DiscordAdapter.start — permanent start errors', () => {
  beforeAll(async () => {
    await loadDiscordSdk();
  });

  for (const code of ['TokenInvalid', 'TokenMissing', 'DisallowedIntents']) {
    it(`marks a ${code} login failure permanent`, async () => {
      const cause = Object.assign(new Error('An invalid token was provided.'), { code });
      const { adapter } = adapterWhoseLoginRejects(cause);
      const thrown = await adapter.start().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown).toMatchObject({ permanent: true });
      expect((thrown as Error).cause).toBe(cause);
    });
  }

  it('marks an HTTP 401 permanent', async () => {
    const { adapter } = adapterWhoseLoginRejects(
      Object.assign(new Error('401: Unauthorized'), { status: 401 }),
    );
    await expect(adapter.start()).rejects.toMatchObject({ permanent: true });
  });

  it('rethrows a transient failure unchanged', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND discord.com');
    const { adapter } = adapterWhoseLoginRejects(cause);
    const thrown = await adapter.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(thrown).toBe(cause);
    expect(thrown).not.toHaveProperty('permanent');
  });
});
