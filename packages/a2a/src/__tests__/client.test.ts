import type { AgentCard } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type A2aClientError, fetchAndVerifyCard } from '../client';
import { buildDidDocument, fingerprint, generateEd25519, signCard } from '../crypto';

function genuineCard(): AgentCard {
  const { privateKeyPem, rawPublicKey } = generateEd25519();
  const jsonRpc = 'http://peer.example/a2a/researcher';
  const unsigned: Omit<AgentCard, 'signature'> = {
    id: 'researcher',
    name: 'Researcher',
    description: 'A careful researcher.',
    protocolVersion: 'a2a/0.1',
    skills: [],
    endpoints: { jsonRpc, auth: 'http://peer.example/a2a-auth/researcher' },
    publicKey: rawPublicKey.toString('base64'),
    keyFingerprint: fingerprint(rawPublicKey),
    signatureAlg: 'ed25519',
    did: buildDidDocument(rawPublicKey, jsonRpc),
  };
  return { ...unsigned, signature: signCard(unsigned, privateKeyPem) };
}

/** A `fetch` stub returning the given JSON body with HTTP 200. */
function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
      statusText: ok ? 'OK' : 'Error',
    })) as unknown as typeof fetch;
}

describe('fetchAndVerifyCard', () => {
  it('returns the verified card for a genuine card', async () => {
    const card = genuineCard();
    const result = await fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
      fetchImpl: fetchReturning(card),
    });
    expect(result.id).toBe('researcher');
  });

  it('passes the fingerprint anchor check when it matches', async () => {
    const card = genuineCard();
    const result = await fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
      fetchImpl: fetchReturning(card),
      expectedFingerprint: card.keyFingerprint,
    });
    expect(result.keyFingerprint).toBe(card.keyFingerprint);
  });

  it('throws bad_signature for a tampered card', async () => {
    const card = genuineCard();
    const tampered: AgentCard = { ...card, name: 'Imposter' };
    await expect(
      fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
        fetchImpl: fetchReturning(tampered),
      }),
    ).rejects.toMatchObject({ code: 'bad_signature' } satisfies Partial<A2aClientError>);
  });

  it('throws fingerprint_mismatch when the anchor differs', async () => {
    const card = genuineCard();
    await expect(
      fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
        fetchImpl: fetchReturning(card),
        expectedFingerprint: 'deadbeef'.repeat(4),
      }),
    ).rejects.toMatchObject({ code: 'fingerprint_mismatch' });
  });

  it('throws fetch_failed on a network error', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', { fetchImpl: failing }),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
  });

  it('throws fetch_failed on a non-2xx response', async () => {
    await expect(
      fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
        fetchImpl: fetchReturning({}, false, 500),
      }),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
  });

  it('throws invalid_card when required fields are missing', async () => {
    await expect(
      fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
        fetchImpl: fetchReturning({ id: 'researcher' }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_card' });
  });
});
