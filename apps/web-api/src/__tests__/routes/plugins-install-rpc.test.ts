import { isValidPluginId } from '@ethosagent/plugin-loader';
import { contract } from '@ethosagent/web-contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../rpc/context';
import { pluginsRouter } from '../../rpc/plugins';

// The `plugins.install` RPC hands `personalityId` to `PluginsService.install`,
// which writes the `plugins.lock` entry only when it gets one. The workspace
// plugins page (`/p/:personalityId/plugins`) sends its route's id; the global
// Library Plugins page and the create wizard send none. This pins the pass-through.
// The service's own behaviour is covered in
// `../services/plugins.service.install.test.ts`.

function makeContext() {
  const install = vi.fn(async (_spec: string, _opts?: { personalityId?: string }) => {});
  // A full RpcContext would drag in every service for a unit-level test.
  const context = { plugins: { install } } as unknown as RpcContext;
  return { context, install };
}

describe('plugins.install RPC', () => {
  it('passes personalityId through to the service', async () => {
    const { context, install } = makeContext();
    const res = await call(
      pluginsRouter.install,
      { packageSpec: 'my-plugin@1.0.0', personalityId: 'researcher' },
      { context },
    );
    expect(res).toEqual({ ok: true });
    expect(install).toHaveBeenCalledWith('my-plugin@1.0.0', { personalityId: 'researcher' });
  });

  it('passes no personalityId when the input has none', async () => {
    const { context, install } = makeContext();
    await call(pluginsRouter.install, { packageSpec: 'my-plugin' }, { context });
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[1]?.personalityId).toBeUndefined();
  });

  it('refuses a non-plain personalityId before the service runs', async () => {
    const { context, install } = makeContext();
    await expect(
      call(pluginsRouter.install, { packageSpec: 'my-plugin', personalityId: '../x' }, { context }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});

// web-contracts cannot import plugin-loader, so the contract carries its own copy
// of the rule the service applies. This pins the two to the same verdicts.
describe('contract personalityId rule matches isValidPluginId', () => {
  const schema = contract.plugins.install['~orpc'].inputSchema;
  it.each([
    'researcher',
    'Strategist',
    'a',
    '0day',
    'my.personality',
    'swing_trader-2',
    '',
    '.hidden',
    '-leading',
    '_leading',
    '../evil',
    'a/b',
    'a\\b',
    'has space',
    'emoji😀',
    'a'.repeat(214),
    'a'.repeat(215),
  ])('%j', async (personalityId) => {
    const result = await schema?.['~standard'].validate({ packageSpec: 'p', personalityId });
    const accepted = result !== undefined && !('issues' in result && result.issues);
    expect(accepted).toBe(isValidPluginId(personalityId));
  });
});
