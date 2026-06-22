export interface OAuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  device_authorization_endpoint?: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

function buildWellKnownUrl(baseUrl: string, suffix: string): string {
  const parsed = new URL(baseUrl);
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}/.well-known/${suffix}${path}`;
}

export function buildOAuthMetadataUrl(issuer: string): string {
  return buildWellKnownUrl(issuer, 'oauth-authorization-server');
}

export function buildProtectedResourceMetadataUrl(resourceUrl: string): string {
  return buildWellKnownUrl(resourceUrl, 'oauth-protected-resource');
}

const ENDPOINT_FIELDS = [
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'revocation_endpoint',
  'introspection_endpoint',
  'device_authorization_endpoint',
] as const;

function assertHttps(url: string, field: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${field} must use https: protocol, got ${parsed.protocol}`);
  }
}

export function parseOAuthServerMetadata(data: unknown): OAuthServerMetadata {
  if (typeof data !== 'object' || data === null) {
    throw new Error('OAuth server metadata must be a non-null object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.authorization_endpoint !== 'string') {
    throw new Error('authorization_endpoint must be present and a string');
  }
  if (typeof obj.token_endpoint !== 'string') {
    throw new Error('token_endpoint must be present and a string');
  }

  for (const field of ENDPOINT_FIELDS) {
    const value = obj[field];
    if (typeof value === 'string') {
      assertHttps(value, field);
    }
  }

  if (Array.isArray(obj.code_challenge_methods_supported)) {
    const methods = obj.code_challenge_methods_supported as string[];
    if (!methods.includes('S256')) {
      throw new Error('code_challenge_methods_supported must include S256');
    }
  }

  return {
    issuer: typeof obj.issuer === 'string' ? obj.issuer : undefined,
    authorization_endpoint: obj.authorization_endpoint,
    token_endpoint: obj.token_endpoint,
    registration_endpoint:
      typeof obj.registration_endpoint === 'string' ? obj.registration_endpoint : undefined,
    revocation_endpoint:
      typeof obj.revocation_endpoint === 'string' ? obj.revocation_endpoint : undefined,
    introspection_endpoint:
      typeof obj.introspection_endpoint === 'string' ? obj.introspection_endpoint : undefined,
    scopes_supported: Array.isArray(obj.scopes_supported)
      ? (obj.scopes_supported as string[])
      : undefined,
    code_challenge_methods_supported: Array.isArray(obj.code_challenge_methods_supported)
      ? (obj.code_challenge_methods_supported as string[])
      : undefined,
    device_authorization_endpoint:
      typeof obj.device_authorization_endpoint === 'string'
        ? obj.device_authorization_endpoint
        : undefined,
  };
}

export function parseProtectedResourceMetadata(data: unknown): ProtectedResourceMetadata {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Protected resource metadata must be a non-null object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.resource !== 'string') {
    throw new Error('resource must be present and a string');
  }

  return {
    resource: obj.resource,
    authorization_servers: Array.isArray(obj.authorization_servers)
      ? (obj.authorization_servers as string[])
      : undefined,
  };
}
