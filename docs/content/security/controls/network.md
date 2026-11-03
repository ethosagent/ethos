---
title: "Security controls: network controls"
description: "Per-personality network policy, SSRF, scheme allowlist and DNS pinning."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

Per-personality network policy, SSRF protection, the scheme allowlist, DNS pinning and the browser-proxy caveats. Part of the [Security controls](../controls.md).

## Network controls {#network-controls}

### Per-personality network policy {#per-personality-network-policy}

*Status: Shipped.*

A personality's `safety.network` block narrows which hosts its tools may reach. It lists hosts only — no ports, no protocols. The scheme is a separate global gate (see [Scheme allowlist](#scheme-allowlist)).

```yaml
safety:
  network:
    allow:
      - api.github.com
      - "*.slack.com"
    deny:
      - uploads.example.com
    allow_private_urls: false
```

| Field | Meaning |
|---|---|
| `allow` | Host patterns: an exact host, a leading `*.` that matches the domain and its subdomains, or a bare `*` that matches every host (`hostnameMatches` in `packages/safety/network/src/policy.ts`). Absent, `[]` and `['*']` all mean no allow list. |
| `deny` | Same pattern grammar. Checked before `allow`, so deny wins (`checkAllowDeny`). A bare `*` denies every host. |
| `allow_private_urls` | Opts into RFC1918, loopback and link-local destinations. Default `false`. Cloud-metadata hosts stay blocked regardless. |

The set of hosts a tool can reach is the intersection of what the tool declares (`capabilities.network.allowedHosts`) and the personality's `allow` (`resolveCapabilities` in `packages/core/src/capability-resolver.ts`; refusals are `HOST_NOT_ALLOWED` from `ScopedFetchImpl`):

| Tool declares | No `safety.network.allow` | With `safety.network.allow` |
|---|---|---|
| Specific hosts (e.g. a search API) | The tool's declared hosts | Declared hosts that a personality pattern covers |
| `['*']` (e.g. `web_extract`) | Any public host | The personality's `allow` list |

With no allow list, a `['*']` tool reaches any public host, but only over `http(s)`: private, loopback, link-local and cloud-metadata destinations stay refused by `safeFetch` (`validateUrl` in `packages/safety/network/src/safe-fetch.ts`; see [SSRF protection](#ssrf-protection)). Declare an `allow` list on any personality whose web tools should reach only named hosts.

- Source: `PersonalitySafetyConfig.network` in `packages/types/src/personality.ts`; parsed in `extensions/personalities/src/index.ts`
- Tests: `packages/wiring/src/__tests__/personality-network-policy.test.ts`; `packages/core/src/__tests__/capability-resolver.test.ts` (`'*' tool on a personality with no allow list — real safeFetch`); `packages/safety/network/src/__tests__/policy.test.ts` and `safe-fetch.test.ts`

### SSRF protection {#ssrf-protection}

*Status: Shipped.*

`safeFetch` rejects requests whose resolved addresses are private (RFC1918), loopback, or link-local, unless the personality sets `allow_private_urls: true`. Operator-initiated A2A peering (`ethos a2a peer add` and the web Add-peer dialog) reads no personality's policy: its card fetch opts into private destinations only when `~/.ethos/config.yaml` sets `a2a.peering.allowPrivateUrls: true` (`A2aPeeringService.fetchVerified` in `packages/wiring/src/a2a-peering-service.ts`; pinned by `packages/wiring/src/__tests__/a2a-peering-private-urls.test.ts`). Cloud-metadata hosts are rejected even then: `169.254.169.254`, `metadata.google.internal`, `metadata`, `metadata.azure.com`, `metadata.aws.amazon.com`, `fd00:ec2::254`, Alibaba's `100.100.100.200`, and Oracle's `169.254.0.23`.

- Source: `validateUrl` and `safeFetch` in `packages/safety/network/src/safe-fetch.ts`
- Cloud metadata blocklist: `isCloudMetadataHost` in `packages/safety/network/src/cloud-metadata.ts`

### Scheme allowlist {#scheme-allowlist}

*Status: Shipped.*

URLs must use `http` or `https`. `file://`, `gopher://`, `ftp://`, `data:` and every other scheme are rejected, and so is a URL with embedded credentials (`http://user:pass@host`). `safeFetch` follows redirects manually, at most 5 hops, and re-runs the full check on every hop — a server-side `302` to `file:///etc/passwd` is rejected at the redirect, not at the request.

- Source: `checkScheme` in `packages/safety/network/src/scheme.ts`; the per-hop loop in `safeFetch` (`DEFAULT_MAX_REDIRECTS`)

### DNS pinning per HTTP client {#dns-pinning-per-http-client}

*Status: Shipped for `safeFetch`'s default transport. Not covered: an injected `fetchImpl`, and the browser route guard.*

`safeFetch` resolves the hostname once, validates every returned address, and then connects with `pinnedFetch`: undici's `fetch` with a per-request `Agent` whose `connect.lookup` (`pinnedLookup`) answers only with the addresses validation accepted. The socket connects to an address that was checked, so there is no second resolution for a DNS-rebinding attacker to win. Each redirect hop is re-validated and gets its own pinned `Agent`. The hostname still drives the Host header, TLS SNI and certificate verification.

Tools reach the network through `ctx.scopedFetch` — `ScopedFetchImpl`, which calls the real `safeFetch` on its default transport (the capability backends in `packages/wiring/src/build-infrastructure.ts`) — so `web_extract` and every other tool using `ctx.scopedFetch` is pinned. `web_extract`'s own `checkSsrf` lookup (`extensions/tools-web/src/ssrf.ts`) runs first as an early refusal only; the connection still goes through `safeFetch`.

| Path | Pinned? |
|---|---|
| `safeFetch` default transport, and every `ctx.scopedFetch` caller | Yes |
| A caller that injects its own `fetchImpl` — the one production case is the vision input resolver's `ctx.fetchImpl` seam (`extensions/tools-vision/src/input-resolver.ts`) | No: the injected function resolves however it likes |
| Browser sessions (`installRouteGuard`) | No: the guard validates the URL, and Chromium resolves the name again when it connects |

- Source: `pinnedFetch` and `pinnedLookup` in `packages/safety/network/src/safe-fetch.ts`
- Tests: `packages/safety/network/src/__tests__/safe-fetch.test.ts` ("connection pinning"); `extensions/tools-web/src/__tests__/web-extract-pinning.test.ts` (`web_extract` connects through the pinned transport)

### The browser SSRF guard does not survive an upstream proxy {#ssrf-browser-proxy}

*Status: Not covered. Read this before setting [`browser.proxy.server`](../../using/reference/config-yaml.md#browser).*

Browser sessions carry their own SSRF guard: `installRouteGuard` puts a `context.route('**/*')` handler on every Playwright context, and each request is checked by the same `validateUrl` the fetch path uses, with hostnames resolved through `node:dns/promises#lookup`.

That resolution happens in the **Ethos process**. A proxied navigation is never resolved there. Chromium sends `CONNECT <host>:<port>` to the proxy and the **proxy** resolves the name, on its own resolver, inside its own network. So the guard checks an address the connection does not use, and a hostname that answers with a public IP here can answer with `10.0.0.5` inside the proxy's LAN. Ethos cannot see that and does not block it.

Literal IPs are unaffected — a URL with a private address in it is rejected before any resolution happens, proxy or not. The gap is names only, and it is not a bug we can close from this side: the resolver that matters belongs to the proxy.

Deploy a proxy you trust not to act as an SSRF pivot — one that cannot reach your internal network, or that enforces its own egress policy. The browser route guard is not that control and must not be relied on as one.

- Source: [`extensions/tools-browser/src/session-route.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/session-route.ts)

### A takeover hands a human the agent's live browser {#browser-takeover-exposure}

*Status: Shipped, opt-in per personality.*

`browser_request_takeover` pauses the agent and hands the **live browser session** to whoever answers the request. That session is not a blank window: it holds every cookie and every logged-in tab the agent accumulated, and when [`browser.profiles.enabled`](../../using/reference/config-yaml.md#browser) is on it is signed into whatever that personality's persistent profile is signed into — across turns, and across `/new`.

Two things follow. The window itself is open on the machine running Ethos, so anyone at that machine can drive it. And the request is raised with `answerableBy: 'anyone'`, so in a group chat any member — not only the person the agent was talking to — may cancel it or follow the link into the web chat to hand it back.

Grant the tool in `toolset.yaml` only to personalities whose browser you are willing to hand over, and keep a persistent profile signed into accounts you would put in front of that audience.

- Source: [`extensions/tools-browser/src/browser-takeover.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/browser-takeover.ts)

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.
