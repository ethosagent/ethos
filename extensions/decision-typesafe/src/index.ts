// @ethosagent/decision-typesafe — TypeSafe's Jev as a DecisionProvider
// (plan/phases/decision-provider-jev.md, M1a).
//
// UNVERIFIED against a live key: the wire shapes in ./transport and ./mapping
// are written from the `/v1/systemone` API reference (D3), not a recorded
// response. Every test runs against an injected stub `fetch`.
//
// The contract it implements, `DecisionProvider` and `DECISION_LIMITS`, is
// owned by `@ethosagent/types` (packages/types/src/decision.ts); import it from
// there, not from here.

export type { DecisionBreakerEvent } from './breaker';
export {
  createTypesafeDecisionProvider,
  TYPESAFE_DEFAULT_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_DEFAULT_TIMEOUT_MS,
  type TypesafeDecisionProviderOptions,
} from './provider';
export {
  type FetchLike,
  type PostSystemOneOptions,
  type PostSystemOneResult,
  postSystemOne,
} from './transport';
export { type DecisionValidation, validateDecisionRequest } from './validate';
