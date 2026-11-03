# @ethosagent/oauth

## Purpose

OAuth 2.0 client runtime for providers and tools that need user credentials: a service that authorizes and hands out access tokens with refresh, a provider registry, a per-personality token store on `Storage`, and the two flows that need a listener or polling (loopback redirect, device code). Token and provider types come from `@ethosagent/oauth-core`; secret encryption comes from `@ethosagent/storage-crypto`.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `DefaultOAuthService` | class | `authorize`, `getAccessToken` with auto-refresh, and revoke over the registry and token store. |
| `DefaultOAuthRegistry` | class | Registry of OAuth provider definitions. |
| `OAuthTokenStore` | class | Reads and writes a `TokenSet` per personality and provider on `Storage`. |
| `startLoopbackServer` | function | Local redirect listener that resolves the `code` and `state`. |
| `LoopbackServerOptions` | interface | Port, path and timeout. |
| `LoopbackServerResult` | interface | Port, redirect URI, result promise, `close`. |
| `startDeviceCodeFlow` | function | Device authorization request and token polling. |
| `DeviceCodeOptions` | interface | Device-flow inputs. |
| `DeviceCodeResult` | interface | Tokens from a completed device flow. |
| `DeviceAuthorizationResponse` | interface | The provider's device authorization reply. |

## Seam

`DefaultOAuthService` and `DefaultOAuthRegistry` implement `OAuthService` and `OAuthRegistry` from `@ethosagent/types` (`implements` in `src/oauth-service.ts` and `src/registry.ts`). `OAuthTokenStore` takes a `Storage`. Archcheck layer: `extensions`.

Pinned by `src/__tests__/oauth-service.test.ts` (an expired token is refreshed, a rotated refresh token is stored, concurrent calls share one refresh, no tokens or no refresh token throws) and `src/__tests__/token-store.test.ts` (credentials are isolated per personality and per provider; an invalid provider id throws `Unsafe providerId`).

## Testing

```
pnpm vitest run extensions/oauth
```

Pinning tests in `src/__tests__/`: `src/__tests__/oauth-service.test.ts`, `src/__tests__/token-store.test.ts`, `src/__tests__/loopback-server.test.ts` (404 on wrong path, 405 on non-GET, 400 on missing code or state, a second callback is rejected), `src/__tests__/device-code.test.ts` (polling, `slow_down`, `expired_token`, `access_denied`, abort signal).
