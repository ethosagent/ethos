// A2A discovery — the public well-known Agent Card route (plan §6/§10/§12).
//
// One self-describing GET returns the signed `AgentCard`: who the agent is,
// how to authenticate, how to talk, and what it can do. This factory produces a
// Hono sub-router; the serve/web-api wiring (Phase 5) mounts it through the
// Phase-2 `RouteModule` seam as a `public` module. It stays a pure package
// concern — it imports ONLY `@ethosagent/types` + `hono` and receives the
// identity provider by injection, so nothing here reaches into apps/extensions.

import { type A2aIdentityProvider, EthosError } from '@ethosagent/types';
import { Hono } from 'hono';

export interface A2aWellKnownRouterOptions {
  /**
   * The identity provider projecting a personality → signed `AgentCard`.
   * Injected (not imported) so this package never depends on the personalities
   * extension. `extensions/personalities`'s `PersonalityA2aIdentityProvider`
   * satisfies it.
   */
  getIdentity: A2aIdentityProvider;
}

/**
 * Build the well-known Agent Card router:
 *
 *   GET /.well-known/agent-card.json?personality=<id>
 *
 * DECISION (plan §6): the PUBLIC, unauthenticated well-known route serves the
 * `stranger` audience tier — a minimal card (name + description headline, no
 * private skill list). A trusted peer earns the fuller card only AFTER the
 * Phase-4 auth handshake, never from this open endpoint. A missing or unknown
 * `personality` yields a typed 404.
 */
export function createA2aWellKnownRouter(opts: A2aWellKnownRouterOptions): Hono {
  const provider = opts.getIdentity;
  const router = new Hono();

  router.get('/.well-known/agent-card.json', async (c) => {
    const personality = c.req.query('personality');
    if (!personality) {
      return c.json({ error: 'NOT_FOUND', message: 'Missing `personality` query parameter.' }, 404);
    }

    try {
      const card = await provider.getIdentity(personality, 'stranger');
      return c.json(card);
    } catch (err) {
      if (err instanceof EthosError && err.code === 'PERSONALITY_NOT_FOUND') {
        return c.json(
          { error: 'NOT_FOUND', message: `Unknown personality "${personality}".` },
          404,
        );
      }
      throw err;
    }
  });

  return router;
}
