export interface OAuthProviderProfile {
  id: string;
  flow:
    | { kind: 'authorization_code' }
    | { kind: 'device_code' }
    | { kind: 'client_credentials' }
    | { kind: 'custom'; provider: string };
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  discovery?:
    | { kind: 'oauth-as-metadata'; issuer: string }
    | { kind: 'mcp-protected-resource'; resourceUrl: string };
  clientId?: string;
  clientAuth?: 'none' | 'client_secret_post' | 'client_secret_basic' | 'private_key_jwt' | 'mtls';
  registration?: { kind: 'dcr'; endpoint?: string }
              | { kind: 'client-id-metadata-document'; url: string };
  scopes?: string[];
  redirect?: RedirectStrategy;
  audience?: string;
  tokenAuthHeader?: 'bearer' | { custom: true };
  refreshable?: boolean;
  fallback?: { kind: 'api-key'; envVar: string };
  credentialSource?: 'interactive' | 'plugin-settings' | 'env';
}

export type RedirectStrategy =
  | { mode: 'loopback'; port?: number; path?: string }
  | { mode: 'device-code' }
  | { mode: 'auto' };

export interface CredentialRef {
  providerId: string;
  profile?: string;
  personalityId: string;
}

export interface OAuthService {
  authorize(profile: OAuthProviderProfile, ref: CredentialRef,
            opts?: { signal?: AbortSignal; onUserPrompt?: (p: UserPrompt) => void }): Promise<void>;
  getAccessToken(ref: CredentialRef): Promise<string>;
  revoke(ref: CredentialRef): Promise<void>;
  status(ref: CredentialRef): Promise<{ present: boolean; expiresAt?: string; scopes?: string[] }>;
}

export type UserPrompt =
  | { kind: 'open-url'; url: string }
  | { kind: 'device-code'; verificationUri: string; userCode: string; expiresIn: number };

export interface CustomFlowProvider {
  id: string;
  buildAuthorizeUrl?(ctx: { creds: ClientCreds; redirectUri?: string }): string;
  extractGrant?(callbackParams: Record<string, string>): GrantInput;
  exchange(grant: GrantInput, creds: ClientCreds): Promise<TokenSet>;
  refresh?(token: TokenSet, creds: ClientCreds): Promise<TokenSet>;
  authorizeRequest(req: HttpRequest, token: TokenSet, creds: ClientCreds): void;
  tokenLifetime?(token: TokenSet): { expiresAt?: string };
}

export interface OAuthRegistry {
  registerProfile(profile: OAuthProviderProfile): void;
  registerCustomFlow(provider: CustomFlowProvider): void;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scopes?: string[];
  token_type?: string;
}

export interface ClientCreds {
  clientId: string;
  clientSecret?: string;
}

export interface GrantInput {
  code?: string;
  [key: string]: unknown;
}

export interface HttpRequest {
  headers: Record<string, string>;
}
