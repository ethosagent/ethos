import { describe, expect, it } from 'vitest';

describe('rpc', () => {
  it('exports reinitializeClient function', async () => {
    const mod = await import('../rpc');
    expect(typeof mod.reinitializeClient).toBe('function');
  });

  it('exports client and rpc', async () => {
    const mod = await import('../rpc');
    expect(mod.client).toBeDefined();
    expect(mod.rpc).toBeDefined();
  });
});
