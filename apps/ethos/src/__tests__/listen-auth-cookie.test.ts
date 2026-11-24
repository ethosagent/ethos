// `ethos listen` authenticates against a server that may run with ETHOS_WEB_TOKEN.
// In that mode the server never reads the token file, so the daemon must use the
// env token too — and must not mint a token file that disagrees with the server.

import { ethosDir } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { authCookie } from '../commands/listen-daemon';

const ENV_TOKEN = 'e'.repeat(64);

describe('authCookie', () => {
  it('uses the env token and writes no token file when ETHOS_WEB_TOKEN is set', async () => {
    const storage = new InMemoryStorage();
    const out = await authCookie(storage, () => ENV_TOKEN);
    expect(out).toEqual({ authCookie: `ethos_auth=${ENV_TOKEN}` });
    expect(await storage.read(`${ethosDir()}/web-token`)).toBeNull();
  });

  it('falls back to the stored token (minted once) when the env is unset', async () => {
    const storage = new InMemoryStorage();
    const out = await authCookie(storage, () => undefined);
    const stored = (await storage.read(`${ethosDir()}/web-token`))?.trim();
    expect(stored).toBeTruthy();
    expect(out).toEqual({ authCookie: `ethos_auth=${stored}` });
  });
});
