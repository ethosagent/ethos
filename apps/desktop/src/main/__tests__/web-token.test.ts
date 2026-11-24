// The embedded web-api runs IN the Electron main process (serve.ts calls
// createWebApi), so it reads ETHOS_WEB_TOKEN from this process's env and then
// ignores the token file. The cookie the desktop sets and the satellite's
// upgrade cookie must come from the same source, or every request is a 401.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { createDesktopWebTokenRepository } from '../web-token';

const ENV_TOKEN = 'e'.repeat(64);

describe('createDesktopWebTokenRepository', () => {
  it('returns the env token and writes no token file when ETHOS_WEB_TOKEN is set', async () => {
    const storage = new InMemoryStorage();
    const repo = createDesktopWebTokenRepository('/data', storage, () => ENV_TOKEN);
    expect(await repo.getOrCreate()).toBe(ENV_TOKEN);
    expect(await storage.read('/data/web-token')).toBeNull();
  });

  it('falls back to the stored token (minted once) when the env is unset', async () => {
    const storage = new InMemoryStorage();
    const repo = createDesktopWebTokenRepository('/data', storage, () => undefined);
    const token = await repo.getOrCreate();
    expect(token).not.toBe(ENV_TOKEN);
    expect((await storage.read('/data/web-token'))?.trim()).toBe(token);
  });
});
