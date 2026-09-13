// Model registry — the on-demand model test (T1.24).
//
// The handler's whole job is to call `testModelAlias` from `@ethosagent/wiring`,
// which is the SAME function `ethos models test` calls. One definition of what
// a test is, two front doors (D28).
//
// Nothing is cached and nothing is written: a test returns its outcome to its
// caller and nothing else, which is the whole of what a test is until T2.13
// adds the health cache and re-points this write into it.

import type { EthosConfig } from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import {
  type ModelTestOutcome,
  type ModelTestProbe,
  type ModelTestRateLimiter,
  testModelAlias,
} from '@ethosagent/wiring';

export interface ModelRegistryServiceOptions {
  /** Reads `<dataDir>/config.yaml` — the same file the rest of this app reads. */
  readConfig: () => Promise<EthosConfig | null>;
  /** Resolves the `${secrets:…}` reference a provider entry's `apiKey` holds. */
  secrets: SecretsResolver;
  /** Test seam. Absent in production, where the real probe is used. */
  probe?: ModelTestProbe;
  /** Test seam. Absent in production, where the process-wide limiter is used. */
  limiter?: ModelTestRateLimiter;
}

export class ModelRegistryService {
  constructor(private readonly opts: ModelRegistryServiceOptions) {}

  /**
   * Probe the model one alias names, once.
   *
   * `caller` is the rate-limit bucket alongside the alias. This app has no
   * per-user identity to key on — the cookie session and a bearer API key are
   * all a handler can tell apart — so every cookie caller shares one bucket.
   * That is the STRICTER direction (a shared bucket limits more, not less), and
   * it is what the RPC passes in.
   */
  async test(input: { alias: string }, caller: string): Promise<ModelTestOutcome> {
    const config = await this.opts.readConfig();
    if (!config) {
      return {
        state: 'unconfigured',
        alias: input.alias,
        reason: 'No config found at ~/.ethos/config.yaml, so there is no registry to test against.',
        fix: 'Run onboarding, or `ethos setup` from the CLI.',
      };
    }
    return testModelAlias({
      alias: input.alias,
      config,
      secrets: this.opts.secrets,
      caller,
      ...(this.opts.probe ? { probe: this.opts.probe } : {}),
      ...(this.opts.limiter ? { limiter: this.opts.limiter } : {}),
    });
  }
}
