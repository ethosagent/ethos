// @ethosagent/a2a — the A2A transport/security module (plan §2).
//
// This main entry carries the HTTP surface (hono): the well-known card router
// factory and the outbound client. It depends on `@ethosagent/types` + `hono` +
// the sibling `./crypto` entry. Importers who need ONLY the pure primitives
// should import `@ethosagent/a2a/crypto` directly so they never pull in hono.
//
// Layer model (ARCHITECTURE §I): this is a `packages/*` module — it MUST NOT
// import from `extensions/*` or `apps/*`. The identity provider is injected.

export {
  type A2aAuthService,
  type A2aAuthServiceOptions,
  type A2aChallengeStruct,
  type ChallengeRequest,
  type ChallengeResponse,
  type ChallengeResult,
  createA2aAuthRouter,
  createA2aAuthService,
  type RespondResult,
} from './auth';
export {
  A2aClientError,
  type A2aClientErrorCode,
  type FetchAndVerifyCardOptions,
  fetchAndVerifyCard,
} from './client';
export {
  type A2aAuthReceipt,
  type SignedA2aAuthReceipt,
  signReceipt,
  verifyReceipt,
} from './receipts';
export {
  type A2aAllowlist,
  type A2aPeerStore,
  MemoryNonceStore,
  type MemoryNonceStoreOptions,
  type NonceRecord,
  type NonceStore,
  type PeerEntry,
  type PeerGrant,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from './stores';
export {
  type A2aTokenClaims,
  type MintedToken,
  type MintTokenParams,
  mintToken,
  type TokenValidation,
  type ValidateTokenOptions,
  validateToken,
} from './tokens';
export {
  type A2aWellKnownRouterOptions,
  createA2aWellKnownRouter,
} from './well-known';
