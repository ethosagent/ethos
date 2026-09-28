// UBP-018 spec check (2026-09-28, no live WhatsApp test by owner decision):
// drive the INSTALLED Baileys `fetchLatestWaWebVersion` (7.0.0-rc13,
// lib/Utils/generics.js) with a stubbed global `fetch`, and feed its real
// return values to `resolveWaWebVersion`. No module mock — the success and
// failure shapes here are the ones the library actually produces.

import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWaWebVersion } from '../index';

/** Baileys 7.0.0-rc13's bundled default (lib/Defaults/index.js `version`). */
const BUNDLED = [2, 3000, 1035194821];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWaWebVersion against the real fetchLatestWaWebVersion', () => {
  it('uses the client_revision parsed from web.whatsapp.com/sw.js', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('self.__swData={"client_revision":1048172514,"x":1};'),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const raw = await fetchLatestWaWebVersion({});
    expect(raw).toEqual({ version: [2, 3000, 1048172514], isLatest: true });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://web.whatsapp.com/sw.js');
    expect(await resolveWaWebVersion(async () => raw)).toEqual([2, 3000, 1048172514]);
  });

  it('keeps the bundled default when sw.js answers non-2xx (real result: isLatest false + error)', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }));
    const raw = await fetchLatestWaWebVersion({});
    expect(raw.isLatest).toBe(false);
    expect(raw.version).toEqual(BUNDLED);
    expect(raw.error).toBeDefined();
    expect(await resolveWaWebVersion(async () => raw)).toBeUndefined();
  });

  it('keeps the bundled default when sw.js has no client_revision', async () => {
    vi.stubGlobal('fetch', async () => new Response('no revision here'));
    const raw = await fetchLatestWaWebVersion({});
    expect(raw).toMatchObject({ version: BUNDLED, isLatest: false });
    expect(await resolveWaWebVersion(async () => raw)).toBeUndefined();
  });

  it('keeps the bundled default when the lookup is aborted (the adapter passes a timeout signal)', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response('{"client_revision":1}');
    });
    const raw = await fetchLatestWaWebVersion({ signal: AbortSignal.abort() });
    expect(raw).toMatchObject({ version: BUNDLED, isLatest: false });
    expect(await resolveWaWebVersion(async () => raw)).toBeUndefined();
  });
});
