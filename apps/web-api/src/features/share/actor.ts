// The audit actor for a signed-in web request (plan share-links D13): `web:<admin>`.
// There is one admin account (web-auth-bootstrap D3), so the name comes from it, not
// from the cookie; a legacy raw-token cookie on an unclaimed instance reads `web:token`.
// Pinned by __tests__/share-service.test.ts ('actor').

export type ActorReader = () => Promise<string>;

export function createWebActor(admin: { username(): Promise<string | null> }): ActorReader {
  return async () => `web:${(await admin.username()) ?? 'token'}`;
}
