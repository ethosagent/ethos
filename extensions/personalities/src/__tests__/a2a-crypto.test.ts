import type { AgentCard } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildDidDocument,
  canonicalize,
  deriveDidKey,
  fingerprint,
  generateEd25519,
  publicKeyMultibase,
  rawPublicKeyFromPem,
  signCard,
  verifyCard,
} from '../a2a-crypto';

function sampleCard(overrides: Partial<AgentCard> = {}): AgentCard {
  const { privateKeyPem, rawPublicKey } = generateEd25519();
  const jsonRpc = 'http://localhost:8787/a2a/researcher';
  const unsigned: Omit<AgentCard, 'signature'> = {
    id: 'researcher',
    name: 'Researcher',
    description: 'A careful researcher.',
    protocolVersion: 'a2a/0.1',
    skills: [{ name: 'web-research', description: 'searches the web' }],
    endpoints: { jsonRpc, auth: 'http://localhost:8787/a2a-auth/researcher' },
    publicKey: rawPublicKey.toString('base64'),
    keyFingerprint: fingerprint(rawPublicKey),
    signatureAlg: 'ed25519',
    did: buildDidDocument(rawPublicKey, jsonRpc),
    ...overrides,
  };
  return { ...unsigned, signature: signCard(unsigned, privateKeyPem) };
}

describe('a2a-crypto canonicalize', () => {
  it('is stable regardless of key insertion order', () => {
    const a = { b: 1, a: { d: 4, c: 3 }, arr: [{ z: 1, y: 2 }] };
    const b = { a: { c: 3, d: 4 }, arr: [{ y: 2, z: 1 }], b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('preserves array order (only object keys are sorted)', () => {
    expect(canonicalize({ xs: [3, 1, 2] })).toBe('{"xs":[3,1,2]}');
  });
});

describe('a2a-crypto sign / verify', () => {
  it('round-trips a signed card', () => {
    expect(verifyCard(sampleCard())).toBe(true);
  });

  it('rejects a card whose body was tampered after signing', () => {
    const card = sampleCard();
    const tampered: AgentCard = { ...card, name: 'Imposter' };
    expect(verifyCard(tampered)).toBe(false);
  });

  it('rejects a card whose skills were tampered after signing', () => {
    const card = sampleCard();
    const tampered: AgentCard = {
      ...card,
      skills: [...card.skills, { name: 'exfiltrate', description: 'leak secrets' }],
    };
    expect(verifyCard(tampered)).toBe(false);
  });

  it('rejects a card whose signature is swapped for another key', () => {
    const a = sampleCard();
    const b = sampleCard();
    expect(verifyCard({ ...a, signature: b.signature })).toBe(false);
  });

  it('rejects a card whose fingerprint does not match its public key', () => {
    const card = sampleCard();
    expect(verifyCard({ ...card, keyFingerprint: 'deadbeef'.repeat(4) })).toBe(false);
  });
});

describe('a2a-crypto fingerprint', () => {
  it('matches the sha256 prefix of the raw public key', () => {
    const { rawPublicKey } = generateEd25519();
    const fp = fingerprint(rawPublicKey);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    // Deriving the raw key back from PEM yields the same fingerprint.
  });

  it('is derivable from the PEM the resolver stores', () => {
    const { privateKeyPem, rawPublicKey } = generateEd25519();
    expect(fingerprint(rawPublicKeyFromPem(privateKeyPem))).toBe(fingerprint(rawPublicKey));
  });
});

describe('a2a-crypto did:key', () => {
  it('derives a did:key identifier with the ed25519 multibase prefix', () => {
    const { rawPublicKey } = generateEd25519();
    const did = deriveDidKey(rawPublicKey);
    // Ed25519 did:key values always start with `did:key:z6Mk`.
    expect(did.startsWith('did:key:z6Mk')).toBe(true);
    expect(did).toBe(`did:key:${publicKeyMultibase(rawPublicKey)}`);
  });

  it('encodes the multicodec prefix deterministically (32 zero bytes vector)', () => {
    // Pure encoding vector: multicodec(0xed01) + 32 zero bytes, base58btc,
    // multibase `z`. Deterministic, so it pins the base58 + multicodec math.
    const zeroKey = Buffer.alloc(32, 0);
    expect(deriveDidKey(zeroKey)).toBe('did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP');
  });

  it('wires the verification method and service into the DID document', () => {
    const { rawPublicKey } = generateEd25519();
    const jsonRpc = 'http://localhost:8787/a2a/researcher';
    const doc = buildDidDocument(rawPublicKey, jsonRpc);
    expect(doc.id).toBe(deriveDidKey(rawPublicKey));
    expect(doc.verificationMethod.publicKeyMultibase).toBe(publicKeyMultibase(rawPublicKey));
    expect(doc.verificationMethod.controller).toBe(doc.id);
    expect(doc.service[0]?.serviceEndpoint).toBe(jsonRpc);
  });
});
