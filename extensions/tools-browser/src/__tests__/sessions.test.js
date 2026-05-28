// Ch.7 — exercise the policy-fingerprint invariant on findActiveSession
// + getOrCreateSession's cache-hit path. We poke fake sessions into the
// exported `sessions` map (using the exported makeMapKey + policyFingerprint
// helpers so the test exercises the real key derivation) and assert the
// lookup behavior the security design depends on.
import { afterEach, describe, expect, it } from 'vitest';
import { findActiveSession, makeMapKey, policyFingerprint, sessions, } from '../sessions';
function fakeSession(fp) {
    return {
        browser: {},
        context: {},
        page: {},
        refs: new Map(),
        lastUrl: '',
        policyFingerprint: fp,
        consoleLogs: [],
    };
}
afterEach(() => {
    sessions.clear();
});
describe('findActiveSession — policy-fingerprint invariant', () => {
    const sid = 'unit-test-session';
    it('returns undefined when no session exists', () => {
        expect(findActiveSession(sid, {})).toBeUndefined();
    });
    it('returns the session when both map key AND fingerprint match', () => {
        const policy = { allow: ['api.github.com'] };
        sessions.set(makeMapKey(sid, policy), fakeSession(policyFingerprint(policy)));
        const found = findActiveSession(sid, policy);
        expect(found).toBeDefined();
        expect(found?.policyFingerprint).toBe(policyFingerprint(policy));
    });
    it('rejects a session inserted at the right map key with a STALE fingerprint', () => {
        // The exact attack shape Codex flagged: a writer constructed the map
        // key correctly but stamped the wrong fingerprint on the session.
        // The map-key check passes; the explicit fingerprint comparison must
        // reject. Without that comparison, the test would return the stale
        // session.
        const policy = { allow: ['api.github.com'] };
        sessions.set(makeMapKey(sid, policy), fakeSession('definitely-wrong-fingerprint'));
        expect(findActiveSession(sid, policy)).toBeUndefined();
    });
    it('rejects when the policy itself differs from the inserted one', () => {
        const insertedPolicy = { allow: ['a.com'] };
        const lookupPolicy = { allow: ['b.com'] };
        sessions.set(makeMapKey(sid, insertedPolicy), fakeSession(policyFingerprint(insertedPolicy)));
        expect(findActiveSession(sid, lookupPolicy)).toBeUndefined();
    });
});
describe('policyFingerprint — order-independence', () => {
    it('returns the same hash for differently-ordered allow lists', () => {
        expect(policyFingerprint({ allow: ['a.com', 'b.com'] })).toBe(policyFingerprint({ allow: ['b.com', 'a.com'] }));
    });
    it('differs across allow vs deny content', () => {
        expect(policyFingerprint({ allow: ['a.com'] })).not.toBe(policyFingerprint({ deny: ['a.com'] }));
    });
    it('differs across allow_private_urls toggle', () => {
        expect(policyFingerprint({ allow_private_urls: true })).not.toBe(policyFingerprint({ allow_private_urls: false }));
    });
});
