// Decisions — Settings › Models › decision models
// (plan/phases/decision-provider-jev.md §7, §12).
//
// Decision models are a KIND of model; each kind is one entry of
// `DECISION_PROVIDER_CATALOG` (./decision-catalog), and every method here
// reads its vault ref and presentation from that entry. `list` answers the
// whole catalog plus only the ADDED providers — a key is stored, or
// `decisions.provider` names it — so an operator who never added one sees an
// empty list and the Add drawer.
//
// Where Settings sets a decision provider's vault key (the catalog's
// `keyRef`; today `providers/typesafe/apiKey`, `DECISIONS_API_KEY_REF`,
// @ethosagent/config) — the only place that can MINT it. Once stored, the Keys pane's `custom` row
// can also replace or delete it (the limitation keys-catalog.ts records).
// Per-site modes and thresholds are NOT written here: they stay config.yaml
// lines the operator sets deliberately, and `list` reports them read-only as
// `resolveDecisionsConfig` resolves them (R6).
//
// What each call guarantees, pinned by `__tests__/services/decisions.service.test.ts`:
// - `setKey` never echoes the value: the answer carries `redactSecretValue`'s
//   mask only. A blank value or one over 8 KiB is refused (the bounds
//   `KeysService.set` and `NamedSecretsService` apply).
// - `setKey` writes `decisions.provider: typesafe` when the line is absent —
//   through `ConfigRepository.transform`, the single config.yaml writer, with
//   the absence checked inside its lock — and writes NO `decisions.sites.*`
//   line, so this call enables nothing. Site lines an earlier `remove` left
//   behind apply as written once the provider line is back — the Add drawer
//   and the saved-key notice say so (apps/web settings/lib/decision-models.ts). A missing config.yaml is not created (that would read
//   as a finished onboarding).
// - `clearKey` deletes the ref and leaves config.yaml alone. Idempotent.
// - `remove` deletes the ref AND, through the same `transform`, the
//   `decisions.provider` line when it names this provider — only that line:
//   `decisions.sites.*` and the rest stay, inert, because
//   `buildDecisionsConfig` builds no layer without a provider. Idempotent.
// - `test` asks nothing of the provider without a stored key (`no_key`), a
//   blank message or one over `DECISION_TEST_MAX_CHARS` (`invalid`); then one
//   call per caller per `MODEL_TEST_WINDOW_MS` — the model Test's D19 window,
//   enforced here (`ModelTestRateLimiter`, @ethosagent/wiring) and not only in
//   the button, because a test spends the operator's credit.

import {
  DECISION_SITES,
  type DecisionProviderName,
  type EthosConfig,
  resolveDecisionsConfig,
} from '@ethosagent/config';
import { EthosError, redactSecretValue, type SecretsResolver } from '@ethosagent/types';
import type {
  DecisionProviderView,
  DecisionsListResult,
  DecisionsTestResult,
} from '@ethosagent/web-contracts';
import { ModelTestRateLimiter, testDecisionProvider } from '@ethosagent/wiring';
import type { ConfigRepository } from '../repositories/config.repository';
import { DECISION_PROVIDER_CATALOG, decisionProviderType } from './decision-catalog';

/** Upper bound on a stored value — the `KeysService` / `NamedSecretsService` bound. */
const MAX_VALUE_BYTES = 8 * 1024;

/** The longest message `test` sends. */
export const DECISION_TEST_MAX_CHARS = 8000;

export interface DecisionsServiceOptions {
  /** Reads `<dataDir>/config.yaml` through `parseConfigYaml` — the runtime's reader. */
  readConfig: () => Promise<EthosConfig | null>;
  /** The config.yaml writer (`transform` takes its write lock). */
  config: ConfigRepository;
  secrets: SecretsResolver;
  /** Test seam. Absent: one limiter per service, `MODEL_TEST_WINDOW_MS`. */
  limiter?: ModelTestRateLimiter;
  /** Test seam, forwarded to `testDecisionProvider`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export class DecisionsService {
  private readonly limiter: ModelTestRateLimiter;

  constructor(private readonly opts: DecisionsServiceOptions) {
    this.limiter = opts.limiter ?? new ModelTestRateLimiter();
  }

  async list(): Promise<DecisionsListResult> {
    const decisions = (await this.opts.readConfig())?.decisions;
    const providers: DecisionProviderView[] = [];
    for (const type of DECISION_PROVIDER_CATALOG) {
      const key = await this.readKey(type.id);
      const active = decisions?.provider === type.id;
      // Not added: no key and not the active provider. The drawer offers it.
      if (key === null && !active) continue;
      // Another provider's `decisions.*` lines say nothing about this one.
      const resolved = resolveDecisionsConfig(
        active && decisions ? decisions : { provider: type.id },
      );
      providers.push({
        id: type.id,
        label: type.label,
        vendor: type.vendor,
        getKeyUrl: type.getKeyUrl,
        configured: active,
        keyRef: type.keyRef,
        keyPresent: key !== null,
        keyPreview: redactSecretValue(key),
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        host: hostOf(resolved.baseUrl),
        sites: DECISION_SITES.map((site) => {
          const s = resolved.sites[site];
          return {
            site,
            requested: s.requested,
            effective: s.effective,
            missingThresholds: s.missingThresholds,
          };
        }),
      });
    }
    return { catalog: [...DECISION_PROVIDER_CATALOG], providers };
  }

  async setKey(input: {
    providerId: DecisionProviderName;
    value: string;
  }): Promise<{ ok: true; preview: string; providerWritten: boolean }> {
    const type = decisionProviderType(input.providerId);
    const value = input.value.trim();
    if (value === '') {
      throw invalid('The key is empty.', `Paste the key from the ${type.vendor} console.`);
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      throw invalid('Secret value is too large.', 'Keys are short — paste only the key.');
    }
    await this.opts.secrets.set(type.keyRef, value);

    let providerWritten = false;
    if (await this.opts.config.exists()) {
      providerWritten = await this.opts.config.transform<boolean>((current) => {
        if (current.passthrough['decisions.provider'] !== undefined) {
          return { next: null, result: false };
        }
        return {
          next: {
            ...current,
            passthrough: { ...current.passthrough, 'decisions.provider': input.providerId },
          },
          result: true,
        };
      });
    }
    return { ok: true, preview: redactSecretValue(value), providerWritten };
  }

  async clearKey(input: { providerId: DecisionProviderName }): Promise<{ ok: true }> {
    await this.opts.secrets.delete(decisionProviderType(input.providerId).keyRef);
    return { ok: true };
  }

  async remove(input: {
    providerId: DecisionProviderName;
  }): Promise<{ ok: true; providerRemoved: boolean }> {
    await this.opts.secrets.delete(decisionProviderType(input.providerId).keyRef);
    let providerRemoved = false;
    if (await this.opts.config.exists()) {
      providerRemoved = await this.opts.config.transform<boolean>((current) => {
        if (current.passthrough['decisions.provider'] !== input.providerId) {
          return { next: null, result: false };
        }
        const { 'decisions.provider': _removed, ...passthrough } = current.passthrough;
        return { next: { ...current, passthrough }, result: true };
      });
    }
    return { ok: true, providerRemoved };
  }

  /** `caller` is the rate-limit bucket — see `callerOf` in rpc/decisions.ts. */
  async test(
    input: { providerId: DecisionProviderName; message: string },
    caller: string,
  ): Promise<DecisionsTestResult> {
    const apiKey = await this.readKey(input.providerId);
    if (apiKey === null) {
      return {
        ok: false,
        code: 'no_key',
        message: `No key stored at ${decisionProviderType(input.providerId).keyRef}. Add one, then test.`,
      };
    }
    if (input.message.trim() === '') {
      return { ok: false, code: 'invalid', message: 'Type a message to test with.' };
    }
    if (input.message.length > DECISION_TEST_MAX_CHARS) {
      return {
        ok: false,
        code: 'invalid',
        message: `The message is ${input.message.length} characters; a test sends at most ${DECISION_TEST_MAX_CHARS}.`,
      };
    }
    const slot = this.limiter.take(caller, `decisions/${input.providerId}`);
    if (!slot.allowed) {
      return {
        ok: false,
        code: 'rate_limited',
        message: `Tested moments ago. Try again in ${slot.retryAfter}s.`,
        retryAfterSeconds: slot.retryAfter,
      };
    }
    const decisions = (await this.opts.readConfig())?.decisions;
    return testDecisionProvider({
      decisions,
      apiKey,
      message: input.message,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  /** The same presence rule as `buildDecisionProvider`: a read failure or a blank value is no key. */
  private async readKey(providerId: DecisionProviderName): Promise<string | null> {
    const ref = decisionProviderType(providerId).keyRef;
    const key = await this.opts.secrets.get(ref).catch(() => null);
    return key === null || key.trim() === '' ? null : key;
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function invalid(cause: string, action: string): EthosError {
  return new EthosError({ code: 'INVALID_INPUT', cause, action });
}
