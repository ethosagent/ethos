// Full OAuth/PKCE types (provider profiles, credential refs, token sets, etc.)
// live in @ethosagent/oauth-core. This interface remains for legacy MCP OAuth UI.
export interface OAuthConfig {
  provider: string;
  buttonLabel: string;
  buildAuthUrl(params: { redirectUri: string; state: string }): string;
  onCallback(params: { code: string; redirectUri: string }): Promise<void>;
}
