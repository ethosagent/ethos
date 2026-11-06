// `addNoAuthRemoteServer` (commands/mcp.ts): what `ethos catalog install` does
// for an `auth: none` remote entry. The wiring Storage is swapped for an
// in-memory one, so nothing touches ~/.ethos.

import type { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mem } = vi.hoisted(() => ({ mem: { current: undefined as unknown as InMemoryStorage } }));
vi.mock('../wiring', async (orig) => {
  const { InMemoryStorage: Mem } = await import('@ethosagent/storage-fs');
  mem.current = new Mem();
  return { ...(await orig<typeof import('../wiring')>()), getStorage: () => mem.current };
});

import { McpJsonStore } from '@ethosagent/tools-mcp';
import { addNoAuthRemoteServer } from '../commands/mcp';

afterEach(() => vi.restoreAllMocks());

describe('addNoAuthRemoteServer', () => {
  it('upserts a streamable-http entry created_via cli, with no auth block and no personality', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await addNoAuthRemoteServer('deepwiki', 'https://mcp.deepwiki.com/mcp');
    expect(await new McpJsonStore(mem.current).read()).toEqual([
      {
        name: 'deepwiki',
        transport: 'streamable-http',
        url: 'https://mcp.deepwiki.com/mcp',
        created_via: 'cli',
      },
    ]);
  });

  it('refuses a duplicate name, a non-https URL and an invalid name, writing nothing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(addNoAuthRemoteServer('deepwiki', 'https://x.example/mcp')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(addNoAuthRemoteServer('other', 'http://x.example/mcp')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(addNoAuthRemoteServer('a.b', 'https://x.example/mcp')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await new McpJsonStore(mem.current).read()).map((s) => s.name)).toEqual(['deepwiki']);
  });
});
