import { SECRET_NAME_RE } from '@ethosagent/types';
import { z } from 'zod';

export const ModelTierConfigSchema = z.object({
  trivial: z.string().optional(),
  default: z.string().optional(),
  deep: z.string().optional(),
});
export type ModelTierConfigWire = z.infer<typeof ModelTierConfigSchema>;

/**
 * The decision providers the layer knows. Lockstep with `DECISION_PROVIDERS`
 * (@ethosagent/config) and with `DECISION_PROVIDER_CATALOG`
 * (apps/web-api/src/services/decision-catalog.ts) — this package cannot import
 * either, so the three are pinned equal by
 * apps/web-api/src/__tests__/services/decisions.service.test.ts ("catalog").
 * Declared here, not beside the `decisions` namespace in router.ts, because
 * `personalities.update` validates `decisions.provider` against it.
 */
export const DecisionProviderIdSchema = z.enum(['typesafe']);

/** `DECISION_SITES` (@ethosagent/config) / `PersonalityDecisionSiteId` (@ethosagent/types). */
export const DecisionSiteIdSchema = z.enum(['injection', 'approver', 'router']);

/** `DECISION_SITE_MODES` (@ethosagent/config) / `PersonalityDecisionSiteMode` (@ethosagent/types). */
export const DecisionSiteModeSchema = z.enum(['off', 'shadow', 'on']);

/** `PersonalityDecisionSiteReason` (@ethosagent/config). */
export const DecisionSiteReasonSchema = z.enum([
  'undeclared',
  'no-provider',
  'not-configured',
  'threshold-missing',
]);

/**
 * One decision site for one personality, as `resolveCharacterSheetDecisions`
 * (@ethosagent/wiring — the `## Decisions` resolver, which calls
 * `resolvePersonalityDecisionSite`, @ethosagent/config) resolves it against the
 * operator's global `decisions.*`. Computed by web-api (`toDecisionSiteView`,
 * apps/web-api/src/services/decisions.service.ts); the web never re-derives it.
 */
export const DecisionSiteViewSchema = z.object({
  site: DecisionSiteIdSchema,
  /** The personality's `decisions.sites.<site>`; `off` when unset. */
  requested: DecisionSiteModeSchema,
  /** What runs. */
  effective: DecisionSiteModeSchema,
  /** Why `effective` is not simply `requested`, or why the site is off. */
  reason: DecisionSiteReasonSchema.optional(),
  /** Full key names whose absence caused an R6 `on` → `shadow` downgrade. */
  missingThresholds: z.array(z.string()),
  /** Approver only: the personality's `safety.approvalMode` when it is not
   *  `smart`, so the approver is never consulted (plan §4.3). */
  inertApprovalMode: z.string().optional(),
});
export type DecisionSiteView = z.infer<typeof DecisionSiteViewSchema>;

/**
 * The SHAPE of a provider namespace a named secret may be written under —
 * never the roster itself. Which providers exist is DERIVED from the
 * `providers/<segment>/*` prefixes registered tools declare in
 * `capabilities.secrets` (`deriveProviderRoster`,
 * `apps/web-api/src/services/derive-provider-roster.ts`), so a tool — including
 * a plugin's — brings its own credential surface with it and this package holds
 * no list to go stale (plan/phases/tool-credential-surface.md D1).
 *
 * The wire therefore asserts only that the value is a single safe path segment,
 * matching `SECRET_NAME_RE`. `NamedSecretsService.assertProvider` is what
 * refuses an unknown one, with the derived roster in the message. Defined here
 * rather than in `router.ts` because two namespaces need it: `namedSecrets`,
 * which owns the write, and `recipes.preflight`, whose credential rows name the
 * provider that write would target.
 */
export const NamedSecretProviderNameSchema = z.string().regex(SECRET_NAME_RE);
