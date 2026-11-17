import { describe, expect, it } from 'vitest';

// boot.ts has no type-only exports, so there is no compile-time tuple here —
// the runtime name list is the whole surface.
describe('boot.ts export surface', () => {
  it('exports exactly the pre-split runtime names', async () => {
    const mod = await import('../commands/boot');
    expect(Object.keys(mod).sort()).toEqual(['channelDigestFeed', 'runBoot']);
  });
});
