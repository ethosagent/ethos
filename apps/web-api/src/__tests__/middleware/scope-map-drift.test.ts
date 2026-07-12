import { ApiKeyScopeSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { COOKIE_ONLY, SCOPE_MAP } from '../../middleware/dual-auth';
import { apiRouter } from '../../rpc/router';

// WEB-001 drift gate. Every RPC method in a namespace that SCOPE_MAP claims to
// govern MUST have an explicit scope entry. Without this, a method added to a
// mapped namespace (e.g. `sessions.export`) silently inherits the fail-closed
// path and becomes cookie-only by accident — or, before the fail-closed fix,
// fell through with NO scope enforced. The reverse assertion catches stale
// mappings pointing at renamed/removed methods.

const router = apiRouter as unknown as Record<string, Record<string, unknown>>;
const validScopes = new Set<string>(ApiKeyScopeSchema.options);

describe('SCOPE_MAP drift — router methods ⊆ SCOPE_MAP per mapped namespace', () => {
  for (const ns of Object.keys(SCOPE_MAP)) {
    const mapped = SCOPE_MAP[ns] ?? {};

    it(`${ns}: every router method has a scope entry`, () => {
      const routerMethods = Object.keys(router[ns] ?? {});
      const missing = routerMethods.filter((m) => !(m in mapped));
      expect(missing).toEqual([]);
    });

    it(`${ns}: no stale scope entries for removed methods`, () => {
      const routerMethods = new Set(Object.keys(router[ns] ?? {}));
      const stale = Object.keys(mapped).filter((m) => !routerMethods.has(m));
      expect(stale).toEqual([]);
    });

    it(`${ns}: every scope value is a real ApiKeyScope or COOKIE_ONLY`, () => {
      for (const scope of Object.values(mapped)) {
        if (scope === COOKIE_ONLY) continue;
        expect(validScopes.has(scope)).toBe(true);
      }
    });
  }
});
