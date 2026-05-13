---
title: "Deploy Mission Control with a remote Ethos"
description: "Run Mission Control on one machine and Ethos on another, with mandatory TLS and network security."
kind: how-to
audience: developer
slug: deploy-mission-control-remote
time: "10 min"
updated: 2026-05-13
---

## Task

Deploy the Mission Control dashboard on one machine (or hosting platform) while Ethos runs on a separate server, with the two connected over the network.

## Result

The dashboard at `https://dashboard.example.com` talks to Ethos at `https://ethos.internal.example.com` via API key auth over TLS.

## Prereqs

- A server running Ethos (`ethos serve`).
- A hosting environment for the Next.js dashboard (Vercel, a VPS, Docker, etc.).
- A domain or IP for both services.
- TLS certificates for the Ethos server (self-signed, Let's Encrypt, or managed by a reverse proxy).

## Security warnings

:::danger
Do not expose Ethos to the public internet without TLS. The API key is sent in the `Authorization` header on every request. Without TLS, it is visible to any network observer. A leaked key grants full access to sessions, memory, and tool execution.
:::

:::warning
Ethos is a single-user server. There is no per-user auth, no role-based access, and no rate limiting. Exposing it to the open internet — even with TLS — means anyone with the API key has full control. Restrict access to a private network, VPN, or SSH tunnel.
:::

## Steps

### 1. Choose a network topology

| Topology | How it works | When to use |
|----------|-------------|-------------|
| **Reverse proxy + TLS** | Nginx/Caddy in front of Ethos terminates TLS | Ethos on a VPS, dashboard on any host |
| **VPN** | Both machines on a private network (Tailscale, WireGuard) | Ethos should never be reachable from the internet |
| **SSH tunnel** | `ssh -L 3000:localhost:3000 ethos-server` | Quick dev/staging, no infra changes |

All three ensure the Ethos API is not reachable from the public internet.

### 2. Configure TLS on the Ethos server

Using Caddy as a reverse proxy (simplest path):

```
# Caddyfile
ethos.internal.example.com {
  reverse_proxy localhost:3000
}
```

Caddy auto-provisions Let's Encrypt certificates. Ethos itself runs on `localhost:3000` and is never directly exposed.

Using Nginx:

```nginx
server {
  listen 443 ssl;
  server_name ethos.internal.example.com;

  ssl_certificate     /etc/letsencrypt/live/ethos.internal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ethos.internal.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;

    # SSE: disable buffering
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
  }
}
```

The `proxy_buffering off` and long `proxy_read_timeout` are critical for SSE. Without them, the reverse proxy buffers events and the dashboard sees delayed or batched updates.

### 3. Mint an API key

```bash
ethos apikey create \
  --name "production-dashboard" \
  --scopes sessions:read,sessions:write,chat:send,personalities:read,memory:read,memory:write,events:subscribe \
  --allowed-origins https://dashboard.example.com
```

Use the production dashboard origin — not `localhost`.

### 4. Configure the dashboard

Set environment variables on the dashboard hosting platform:

```env
NEXT_PUBLIC_ETHOS_BASE_URL=https://ethos.internal.example.com
NEXT_PUBLIC_ETHOS_API_KEY=sk-ethos-...
```

For Vercel, add these in the project settings under Environment Variables.

### 5. Deploy the dashboard

```bash
# Build and deploy (Vercel example)
vercel --prod
```

Or build and serve manually:

```bash
cd examples/mission-control
pnpm build
pnpm start
```

### 6. Verify the connection

Open the deployed dashboard. The Sessions panel should load. Send a test message — the SSE stream should deliver events in real time.

Check the browser Network tab:

- RPC requests go to `https://ethos.internal.example.com/rpc` with `Authorization: Bearer sk-ethos-...`.
- SSE requests go to `https://ethos.internal.example.com/sse/sessions/:id`.
- No mixed-content warnings (all HTTPS).

## Troubleshooting

**CORS errors** — The Ethos server must allow the dashboard's origin. The API key's `allowedOrigins` controls this. Re-mint the key with the correct origin if needed.

**SSE timeout or no events** — The reverse proxy is buffering. Add `proxy_buffering off` (Nginx) or equivalent to the proxy config.

**Mixed content blocked** — The dashboard is on HTTPS but `NEXT_PUBLIC_ETHOS_BASE_URL` points to HTTP. Use HTTPS for both.

**Certificate errors** — Self-signed certificates are rejected by the browser. Use Let's Encrypt, or add the CA to the trust store for internal deployments.
