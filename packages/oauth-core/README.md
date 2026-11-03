# @ethosagent/oauth-core

## Purpose

Pure OAuth building blocks: authorization URLs, PKCE verifier/challenge, state generation, dynamic client registration (DCR) request and response handling, server and protected-resource metadata discovery, and token exchange, refresh and revocation parameters. The shared provider, registry and service types live in `src/types.ts`.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `buildAuthorizationUrl` | function | Builds an authorization URL. |
| `generateCodeVerifier` | function | Generates a PKCE code verifier. |
| `generateCodeChallenge` | function | Derives a PKCE code challenge. |
| `generateState` | function | Generates an OAuth state value. |
| `buildDcrRequest` | function | Builds a DCR request. |
| `parseDcrResponse` | function | Parses a DCR response. |
| `buildOAuthMetadataUrl` | function | URL for authorization-server metadata. |
| `buildProtectedResourceMetadataUrl` | function | URL for protected-resource metadata. |
| `parseOAuthServerMetadata` | function | Parses authorization-server metadata. |
| `parseProtectedResourceMetadata` | function | Parses protected-resource metadata. |
| `buildTokenExchangeParams` | function | Parameters for a code exchange. |
| `buildRefreshParams` | function | Parameters for a refresh. |
| `buildRevocationParams` | function | Parameters for a revocation. |
| `parseTokenResponse` | function | Parses a token response. |
| `isTokenExpired` | function | Whether a token set has expired. |
| `OAuthProviderProfile` | type | Provider description. |
| `OAuthService` | type | OAuth service interface. |
| `OAuthRegistry` | type | Provider registry interface. |
| `TokenSet` | type | Token set. |

## Seam

Support package of builders and parsers; HTTP is left to callers. Archcheck layer: `support`. There is no ARCHITECTURE.md law specific to this package.

## Testing

```
pnpm vitest run packages/oauth-core
```

Pinning tests:
- `src/__tests__/pkce.test.ts`: PKCE verifier and challenge.
- `src/__tests__/authorize.test.ts`: authorization URL.
- `src/__tests__/dcr.test.ts`: DCR request and response.
- `src/__tests__/discovery.test.ts`: metadata discovery.
- `src/__tests__/token.test.ts`: token parameters and parsing.
- `src/__tests__/state.test.ts`: state generation.
