# @ethosagent/safety-network

## Purpose

Outbound URL safety for tools: scheme checks, cloud-metadata host detection, per-personality allow and deny lists, and `safeFetch`, which validates the URL, revalidates each redirect hop, and on the default path pins the connection to the addresses validation accepted (via `undici`).

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `safeFetch` | function | Fetch with URL validation and per-hop redirect revalidation. |
| `validateUrl` | function | Validates one URL against the full pipeline. |
| `SafeFetchOptions` | type | Options for `safeFetch`. |
| `SafeFetchResult` | type | Result of `safeFetch`. |
| `SafeFetchError` | type | Error shape of `safeFetch`. |
| `checkScheme` | function | Rejects non-http(s) schemes, credentials and malformed URLs. |
| `SchemeCheckResult` | type | Result of `checkScheme`. |
| `isCloudMetadataHost` | function | Whether a host is a cloud-metadata endpoint. |
| `checkAllowDeny` | function | Applies a network policy to a host. |
| `hostnameMatches` | function | Exact and `*.` glob host matching. |
| `NetworkPolicy` | type | Allow and deny configuration. |
| `PolicyCheckResult` | type | Result of `checkAllowDeny`. |

## Seam

Security-kernel layer (`kernel-reads-contracts` in `architecture.config.ts`); depends on `@ethosagent/types` and `undici`. ARCHITECTURE.md Law 11 applies. Behaviour is pinned by the tests below; no static rule enforces that every tool fetches through `safeFetch` (limitation).

## Testing

```
pnpm vitest run packages/safety/network
```

- `src/__tests__/safe-fetch.test.ts`: non-http schemes and cloud-metadata hosts rejected, even with `allow_private_urls`.
- `src/__tests__/scheme.test.ts`: embedded credentials and malformed URLs rejected.
- `src/__tests__/cloud-metadata.test.ts`: metadata host matching.
- `src/__tests__/policy.test.ts`: host glob matching and allow/deny.
