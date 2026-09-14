import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import {
  ModelTestRateLimiter,
  type ProbeProviderOutcome,
  testModelAlias,
} from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { ModelRegistryService } from '../../services/model-registry.service';
import { config, inertSeams, service } from './model-registry-fixture';

// `modelRegistry.test` (T1.24). The service IS the handler's whole body, so
// these exercise it directly. The rate limit has its own file.

describe('modelRegistry.test', () => {
  it('a passing test reports latency and the echoed model id only when it differs', async () => {
    const differs = service(() => ({
      ok: true,
      latencyMs: 340,
      echoedModel: 'claude-opus-5-20260114',
    }));
    expect(await differs.svc.test({ alias: 'opus' }, 'cookie')).toEqual({
      state: 'ok',
      alias: 'opus',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      latencyMs: 340,
      echoedModel: 'claude-opus-5-20260114',
    });

    // Identical to the requested id → the field is not carried at all, so no
    // surface has to re-decide whether it is worth rendering.
    const same = service(() => ({ ok: true, latencyMs: 12, echoedModel: 'claude-opus-5' }));
    expect('echoedModel' in (await same.svc.test({ alias: 'opus' }, 'cookie'))).toBe(false);

    // And a provider that named no model at all carries nothing either.
    const silent = service(() => ({ ok: true, latencyMs: 12 }));
    expect('echoedModel' in (await silent.svc.test({ alias: 'opus' }, 'cookie'))).toBe(false);
  });

  it('a failing test surfaces the vendor body verbatim and untruncated', async () => {
    const vendor =
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\n' +
      `padding: ${'y'.repeat(6000)}`;
    const { svc } = service(() => ({ ok: false, reason: 'rejected', error: vendor }));
    const out = await svc.test({ alias: 'opus' }, 'cookie');
    expect(out.state).toBe('rejected');
    if (out.state !== 'rejected') return;
    expect(out.error).toBe(vendor);
    expect(out.error.length).toBe(vendor.length);
    expect(out.fix).toContain('anthropic-work');
  });

  it('an unreachable outcome is not reported as a bad key', async () => {
    const { svc } = service(() => ({
      ok: false,
      reason: 'unreachable',
      error: 'timed out after 10s',
    }));
    const out = await svc.test({ alias: 'opus' }, 'cookie');
    expect(out.state).toBe('unreachable');
    expect(out.state === 'unreachable' && out.provider).toBe('anthropic');
    // The one thing it must never become.
    expect(out.state).not.toBe('rejected');
  });

  it('the CLI and the RPC return the same outcome for the same alias', async () => {
    // Both front doors go through `testModelAlias` — the CLI with `caller:
    // 'cli'`, the handler with the request's auth method — so the same alias
    // and the same probe must yield the same VALUE, not two renderings of one.
    // A handler that re-implemented the resolution would diverge here.
    const outcome: ProbeProviderOutcome = {
      ok: true,
      latencyMs: 340,
      echoedModel: 'claude-opus-5-20260114',
    };
    const { svc } = service(() => outcome);
    const viaRpc = await svc.test({ alias: 'opus' }, 'cookie');

    const viaCli = await testModelAlias({
      alias: 'opus',
      config: config(),
      secrets: new InMemorySecretsResolver(),
      caller: 'cli',
      limiter: new ModelTestRateLimiter(),
      probe: async () => outcome,
    });

    expect(viaRpc).toEqual(viaCli);
  });

  it('reports a missing config as unconfigured rather than throwing', async () => {
    const svc = new ModelRegistryService({
      ...inertSeams(),
      readConfig: async () => null,
      secrets: new InMemorySecretsResolver(),
      probe: async () => ({ ok: true, latencyMs: 1 }),
    });
    const out = await svc.test({ alias: 'opus' }, 'cookie');
    expect(out.state).toBe('unconfigured');
  });
});
