// A2A signed audit receipts (plan §13 / O8, pulled forward).
//
// A receipt is a tamper-evident record that an auth decision happened, signed
// by the TARGET agent's Ed25519 key. The format is built here alongside the
// token/identity crypto because it couples to it — retrofitting tamper-evidence
// onto an existing log later is painful (plan §13). The audit SINK
// (observability-sqlite) is Phase 8; this phase only produces + verifies the
// signed artifact and exposes it from the handshake result.
//
// Metadata only (plan §13): the receipt proves THAT an exchange happened
// (personality, peer fingerprint, decision), never WHAT content was exchanged.

import { signStruct, verifyStruct } from './crypto';

/** The unsigned auth receipt — metadata only, no bodies. */
export interface A2aAuthReceipt {
  event: 'a2a-auth';
  personalityId: string;
  peerFingerprint: string;
  decision: 'accepted' | 'rejected';
  /** Present on a rejection — the reason, for the audit trail. */
  reason?: string;
  /** ms epoch. */
  ts: number;
}

/** A receipt plus its base64 Ed25519 signature over the canonical form. */
export interface SignedA2aAuthReceipt {
  receipt: A2aAuthReceipt;
  signature: string;
}

/** Sign a receipt with the target agent's Ed25519 private key (PKCS8 PEM). */
export function signReceipt(receipt: A2aAuthReceipt, privateKeyPem: string): SignedA2aAuthReceipt {
  return { receipt, signature: signStruct(receipt, privateKeyPem) };
}

/**
 * Verify a signed receipt against the target's raw Ed25519 public key. Returns
 * false on any tamper or bad signature — never throws.
 */
export function verifyReceipt(signed: SignedA2aAuthReceipt, rawPublicKey: Buffer): boolean {
  return verifyStruct(signed.receipt, signed.signature, rawPublicKey);
}
