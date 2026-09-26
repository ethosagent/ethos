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

// S7 (plan openclaw-2026.9.6-gaps): `peer_url` is model-chosen, so the card
// fetch runs through `@ethosagent/safety-network`'s `safeFetch` — refused
// BEFORE any request for metadata / private / reserved hosts, and the refusal
// text carries no probe result (no resolved address, no HTTP status).
describe('fetchAndVerifyCard — network policy (S7)', () => {
  function spyFetch(body: unknown): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const inner = fetchReturning(body);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return inner(input, init);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('refuses the cloud-metadata address before any request is made', async () => {
    const { fetchImpl, calls } = spyFetch(genuineCard());
    await expect(
      fetchAndVerifyCard('http://169.254.169.254/latest/meta-data/', { fetchImpl }),
    ).rejects.toMatchObject({ code: 'url_refused' });
    expect(calls).toEqual([]);
  });

  it('refuses a private-range peer before the agent-card fetch', async () => {
    const { fetchImpl, calls } = spyFetch(genuineCard());
    await expect(
      fetchAndVerifyCard('http://10.0.0.5/.well-known/agent-card.json', { fetchImpl }),
    ).rejects.toMatchObject({ code: 'url_refused' });
    expect(calls).toEqual([]);
  });

  it('does not echo the address an internal hostname resolved to', async () => {
    const { fetchImpl, calls } = spyFetch(genuineCard());
    const err = await fetchAndVerifyCard('http://db.internal/.well-known/agent-card.json', {
      fetchImpl,
      resolveHost: async () => ['10.1.2.3'],
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'url_refused' });
    expect(String((err as Error).message)).not.toContain('10.1.2.3');
    expect(calls).toEqual([]);
  });

  it('refuses a redirect from a public peer into a private range', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/' } });
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCard('http://peer.example/.well-known/agent-card.json', {
        fetchImpl,
        resolveHost: async () => ['203.0.113.10'],
      }),
    ).rejects.toMatchObject({ code: 'url_refused' });
    expect(calls).toEqual(['http://peer.example/.well-known/agent-card.json']);
  });

  it('admits a private peer when the policy opts in with allow_private_urls', async () => {
    const card = genuineCard();
    const { fetchImpl, calls } = spyFetch(card);
    const result = await fetchAndVerifyCard('http://10.0.0.5/.well-known/agent-card.json', {
      fetchImpl,
      networkPolicy: { allow_private_urls: true },
    });
    expect(result.id).toBe('researcher');
    expect(calls).toHaveLength(1);
  });
});
