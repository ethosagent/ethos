// Ed25519 keygen / signing / verification and DID (`did:key`) derivation for
// A2A Agent Cards. Uses Node's built-in `crypto` (WebCrypto-grade Ed25519) —
// no hand-rolled primitives (plan §0A / §7). Signing your OWN card is not
// verification; the client-side card VERIFICATION path lives in `packages/a2a`
// (Phase 3). These helpers are reused there for the shared canonicalization +
// key math, so they are exported from the personalities barrel.

import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from 'node:crypto';
import type { AgentCard, DidDocument } from '@ethosagent/types';

/** A freshly generated Ed25519 keypair. */
export interface Ed25519KeyPair {
  /** PKCS8 PEM — the form stored in `SecretsResolver`. */
  privateKeyPem: string;
  /** Raw 32-byte public key. */
  rawPublicKey: Buffer;
}

/** Generate an Ed25519 keypair. */
export function generateEd25519(): Ed25519KeyPair {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKeyPem, rawPublicKey: rawPublicKeyFromPem(privateKeyPem) };
}

/** Extract the raw 32-byte public key from a PKCS8 PEM private key. */
export function rawPublicKeyFromPem(privateKeyPem: string): Buffer {
  const pub = createPublicKey(privateKeyPem);
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('a2a-crypto: Ed25519 public key JWK has no `x` coordinate');
  return Buffer.from(jwk.x, 'base64url');
}

/** Short hex sha256 of the raw public key — the out-of-band trust anchor. */
export function fingerprint(rawPublicKey: Buffer): string {
  return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 32);
}

/**
 * Deterministic JSON serialization with recursively sorted object keys, so a
 * signer and verifier agree byte-for-byte regardless of insertion order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Sign a card. Takes the fully-populated card MINUS its `signature` field and
 * returns the base64 Ed25519 signature over the canonical serialization.
 */
export function signCard(card: Omit<AgentCard, 'signature'>, privateKeyPem: string): string {
  const message = Buffer.from(canonicalize(card), 'utf8');
  return cryptoSign(null, message, privateKeyPem).toString('base64');
}

/**
 * Verify a card end-to-end: (a) the fingerprint matches the embedded public
 * key, and (b) the signature is valid over the card's canonical form (sans
 * `signature`), using the key the card carries. Returns false on any failure.
 */
export function verifyCard(card: AgentCard): boolean {
  const rawPublicKey = Buffer.from(card.publicKey, 'base64');
  if (fingerprint(rawPublicKey) !== card.keyFingerprint) return false;

  const { signature: _sig, ...unsigned } = card;
  const message = Buffer.from(canonicalize(unsigned), 'utf8');
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawPublicKey.toString('base64url') },
    format: 'jwk',
  });
  try {
    return cryptoVerify(null, message, publicKey, Buffer.from(card.signature, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// did:key derivation (multicodec ed25519-pub 0xed01 + base58btc, multibase `z`)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);

function base58btc(bytes: Buffer): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i] ?? 0];
  return out;
}

/**
 * The `did:key` multibase form of an Ed25519 public key: `z` + base58btc of the
 * multicodec-prefixed raw key. Used both as the DID identifier suffix and as
 * `publicKeyMultibase`.
 */
export function publicKeyMultibase(rawPublicKey: Buffer): string {
  return `z${base58btc(Buffer.concat([ED25519_MULTICODEC, rawPublicKey]))}`;
}

/** The full `did:key:z...` identifier for an Ed25519 public key. */
export function deriveDidKey(rawPublicKey: Buffer): string {
  return `did:key:${publicKeyMultibase(rawPublicKey)}`;
}

/** Build the DID-compatible envelope for a card (plan §8). */
export function buildDidDocument(rawPublicKey: Buffer, jsonRpcEndpoint: string): DidDocument {
  const did = deriveDidKey(rawPublicKey);
  const multibase = publicKeyMultibase(rawPublicKey);
  return {
    id: did,
    verificationMethod: {
      id: `${did}#${multibase}`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyMultibase: multibase,
    },
    service: [
      {
        id: `${did}#a2a-json-rpc`,
        type: 'A2aJsonRpc',
        serviceEndpoint: jsonRpcEndpoint,
      },
    ],
  };
}
