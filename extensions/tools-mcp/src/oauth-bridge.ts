import type {
  CredentialRef,
  OAuthProviderProfile,
  OAuthService,
  UserPrompt,
} from '@ethosagent/oauth-core';
import type { DiscoveredOAuthMetadata } from './oauth';

/**
 * Build an OAuthProviderProfile from MCP discovery metadata.
 * Used to route new MCP server authorizations through DefaultOAuthService
 * instead of the standalone flow in oauth.ts.
 */
export function mcpProfileFromDiscovery(
  serverName: string,
  meta: DiscoveredOAuthMetadata,
  clientId: string,
): OAuthProviderProfile {
  return {
    id: `mcp/${serverName}`,
    flow: { kind: 'authorization_code' },
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    revocationEndpoint: meta.revocation_endpoint,
    registration: meta.registration_endpoint
      ? { kind: 'dcr', endpoint: meta.registration_endpoint }
      : undefined,
    scopes: meta.scopes_supported,
    clientId,
    redirect: { mode: 'loopback' },
    refreshable: true,
  };
}

/**
 * Authorize an MCP server through the centralized DefaultOAuthService.
 * New authorizations should prefer this path; the standalone flow in oauth.ts
 * remains for backward compatibility and token migration.
 */
export async function authorizeWithService(
  service: OAuthService,
  profile: OAuthProviderProfile,
  personalityId: string,
  onUserPrompt?: (p: UserPrompt) => void,
): Promise<void> {
  const ref: CredentialRef = {
    providerId: profile.id,
    personalityId,
  };
  await service.authorize(profile, ref, { onUserPrompt });
}
