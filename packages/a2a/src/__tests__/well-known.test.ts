import type { A2aIdentityProvider, AgentAudience, AgentCard } from '@ethosagent/types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildDidDocument, fingerprint, generateEd25519, signCard, verifyCard } from '../crypto';
import { createA2aWellKnownRouter } from '../well-known';

// A minimal identity provider that signs a real card with `@ethosagent/a2a`'s
// own crypto — no personalities dependency (layer model: this package must not
// import extensions). `stranger` yields no skills, mirroring the real provider.
function stubProvider(ids: Set<string>): A2aIdentityProvider {
  return {
    async getIdentity(personalityId: string, audience: AgentAudience): Promise<AgentCard> {
      if (!ids.has(personalityId)) {
        const { EthosError } = await import('@ethosagent/types');
        throw new EthosError({
          code: 'PERSONALITY_NOT_FOUND',
          cause: `Personality "${personalityId}" not found.`,
          action: 'Check the id.',
        });
      }
      const { privateKeyPem, rawPublicKey } = generateEd25519();
      const jsonRpc = `http://localhost:8787/a2a/${personalityId}`;
      const unsigned: Omit<AgentCard, 'signature'> = {
        id: personalityId,
        name: 'Researcher',
        description: 'A careful researcher.',
        protocolVersion: 'a2a/0.1',
        skills:
          audience === 'stranger'
            ? []
            : [{ name: 'secret-skill', description: 'private capability' }],
        endpoints: { jsonRpc, auth: `http://localhost:8787/a2a-auth/${personalityId}` },
        publicKey: rawPublicKey.toString('base64'),
        keyFingerprint: fingerprint(rawPublicKey),
        signatureAlg: 'ed25519',
        did: buildDidDocument(rawPublicKey, jsonRpc),
      };
      return { ...unsigned, signature: signCard(unsigned, privateKeyPem) };
    },
  };
}

// Mirror the Phase-2 `RouteModule` seam mount for a `public` module:
// `app.route(basePath, router)` with no auth middleware. Root basePath so the
// card serves at the domain-root path strict A2A clients expect.
function mountViaSeam(provider: A2aIdentityProvider): Hono {
  const router = createA2aWellKnownRouter({ getIdentity: provider });
  const app = new Hono();
  app.route('/', router); // basePath '/', auth: 'public'
  return app;
}

describe('createA2aWellKnownRouter (via the Phase-2 route seam)', () => {
  it('serves a valid stranger card at the domain-root well-known path', async () => {
    const app = mountViaSeam(stubProvider(new Set(['researcher'])));
    const res = await app.request('/.well-known/agent-card.json?personality=researcher');
    expect(res.status).toBe(200);
    const card = (await res.json()) as AgentCard;
    expect(card.id).toBe('researcher');
    expect(verifyCard(card)).toBe(true);
    // stranger tier: no private skills leak from the public endpoint.
    expect(card.skills).toEqual([]);
  });

  it('returns 404 for an unknown personality', async () => {
    const app = mountViaSeam(stubProvider(new Set(['researcher'])));
    const res = await app.request('/.well-known/agent-card.json?personality=ghost');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NOT_FOUND');
  });

  it('returns 404 when the personality query parameter is missing', async () => {
    const app = mountViaSeam(stubProvider(new Set(['researcher'])));
    const res = await app.request('/.well-known/agent-card.json');
    expect(res.status).toBe(404);
  });
});
