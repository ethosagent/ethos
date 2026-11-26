import { describe, expect, it } from 'vitest';
import { createShareSettings } from '../settings';

// plan share-links D11, D14: settings are read live and any failure reads as OFF.
const read = (src: string | null | Error) =>
  createShareSettings({
    readSource: async () => {
      if (src instanceof Error) throw src;
      return src;
    },
  })();

describe('createShareSettings', () => {
  it('is off with no config, a read error, or no shareLinks key', async () => {
    expect((await read(null)).enabled).toBe(false);
    expect((await read(new Error('EIO'))).enabled).toBe(false);
    expect((await read('model: m\n')).enabled).toBe(false);
  });

  it('reads enabled, the exclude list and webBaseUrl', async () => {
    const s = await read(
      'shareLinks.enabled: true\nshareLinks.excludePersonalities: a,b\nwebBaseUrl: https://x.example\n',
    );
    expect(s).toEqual({
      enabled: true,
      excludePersonalities: ['a', 'b'],
      webBaseUrl: 'https://x.example',
    });
  });

  it('a non-boolean value leaves it off', async () => {
    expect((await read('shareLinks.enabled: yes\n')).enabled).toBe(false);
  });

  it('is not cached: each call re-reads', async () => {
    let src = 'shareLinks.enabled: true\n';
    const settings = createShareSettings({ readSource: async () => src });
    expect((await settings()).enabled).toBe(true);
    src = 'shareLinks.enabled: false\n';
    expect((await settings()).enabled).toBe(false);
  });
});
