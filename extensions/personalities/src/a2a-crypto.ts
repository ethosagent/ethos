// A2A card crypto — re-homed to `@ethosagent/a2a/crypto` (plan §7, Phase 3).
//
// The Ed25519 keygen / signing / canonicalization / `did:key` primitives now
// live ONCE in `packages/a2a`, so signing your OWN card here and VERIFYING a
// peer's card in the A2A client share byte-for-byte canonicalization — no
// sign/verify drift. This module re-exports them so existing importers
// (`./a2a-identity`, the personalities barrel, tests) keep the same import
// path. `extensions/personalities` → `packages/a2a` is a valid extension→
// package dependency (ARCHITECTURE §I).

export {
  buildDidDocument,
  canonicalize,
  deriveDidKey,
  type Ed25519KeyPair,
  fingerprint,
  generateEd25519,
  publicKeyMultibase,
  rawPublicKeyFromPem,
  signCard,
  verifyCard,
} from '@ethosagent/a2a/crypto';
