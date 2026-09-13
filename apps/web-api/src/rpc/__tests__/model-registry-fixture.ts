// Shared fixture for the `modelRegistry.test` handler tests (T1.24).
//
// Split out of the test files so each stays under the `src/rpc/*.ts ≤120 lines`
// cap `__tests__/layering.test.ts` enforces over this directory.

import type { EthosConfig } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import {
  ModelTestRateLimiter,
  type ProbeProviderConfig,
  type ProbeProviderOutcome,
} from '@ethosagent/wiring';
import { ModelRegistryService } from '../../services/model-registry.service';

export function config(): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-test',
    personality: 'assistant',
    providers: [{ provider: 'anthropic', id: 'anthropic-work', apiKey: 'sk-work' }],
    modelRegistry: {
      entries: {
        opus: { alias: 'opus', provider: 'anthropic-work', modelId: 'claude-opus-5' },
        sonnet: { alias: 'sonnet', provider: 'anthropic-work', modelId: 'claude-sonnet-5' },
      },
      default: 'sonnet',
      roles: {},
    },
  } as EthosConfig;
}

/** The service with its probe stubbed — no test touches the network or a key. */
export function service(
  outcome: (cfg: ProbeProviderConfig) => ProbeProviderOutcome,
  opts: { limiter?: ModelTestRateLimiter } = {},
) {
  const probed: ProbeProviderConfig[] = [];
  const svc = new ModelRegistryService({
    readConfig: async () => config(),
    secrets: new InMemorySecretsResolver(),
    // A FRESH limiter per service by default: the process-wide one would make
    // two tests of the same alias collide inside its own 10s window.
    limiter: opts.limiter ?? new ModelTestRateLimiter(),
    probe: async (cfg) => {
      probed.push(cfg);
      return outcome(cfg);
    },
  });
  return { svc, probed };
}
