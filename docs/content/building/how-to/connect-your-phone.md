---
title: "Connect your phone"
description: "Mint a scoped API key and connect the Ethos iOS app to a running ethos serve, so you can chat, approve and get push notifications from your phone."
kind: how-to
audience: developer
slug: connect-your-phone
time: "10 min"
updated: 2026-09-20
---

## Task

Connect the Ethos iOS app (TestFlight) to an `ethos serve` you already run, and understand what it can and cannot do.

## Result

Your phone holds a scoped, revocable API key, shows the same chat and approvals as the web UI, and gets a lock-screen banner the next time an agent asks permission to run a tool.

## Prereqs

- A running `ethos serve` (or `ethos boot`) that your phone can reach over the network — see step 1.
- A TestFlight invite. The app is TestFlight-only for now; ask the owner for one.
- The Ethos web UI open, or a terminal on the machine running the server, to mint the key.

## Steps

### 1. Make the server reachable from a phone

`ethos serve` binds `web.host: 127.0.0.1` (the [`config.yaml`](../../using/reference/config-yaml.md) field, also settable with `--web-host` or `ETHOS_WEB_HOST`) by default — loopback only. A phone on the same Wi-Fi or the same tailnet cannot reach `127.0.0.1`; that address means "this machine" to the phone too. Bind to an address the phone can actually route to:

```yaml
# ~/.ethos/config.yaml
web:
  host: 0.0.0.0 # or your machine's LAN / tailnet address
```

```sh
ethos serve
```

```
ethos web UI listening on http://0.0.0.0:3000
```

If you run behind a reverse proxy or a Tailscale hostname, set `webBaseUrl` (or the `ETHOS_PUBLIC_URL` environment variable) instead, so the QR code and the connect screen show the public name rather than the bind address. `ETHOS_PUBLIC_URL` wins over `webBaseUrl`, which wins over `web.host`.

### 2. Get the key onto the phone

A phone key is a scoped, revocable API key — a bearer credential limited to a fixed set of RPC methods (see the [API key scopes reference](../reference/api-key-scopes.md)) — never your cookie session. Three ways to get one onto the phone, in order:

**First, the web.** Open Settings → Mobile app, click **Generate QR code**, then **Reveal**, and scan it with the app's camera. The QR carries the server URL and the key — nothing else — and disappears once the phone's first authenticated call lands.

**Second, the terminal**, if you are administering a headless server over SSH:

```sh
ethos api-key create --preset phone --qr
```

```
✓ Created  sk-ethos-4f2c...  iphone-mitesh
  scopes: sessions:read, sessions:write, chat:send, personalities:read,
          tools:approve, activity:read, events:subscribe, push:register
  This key lets the phone read, approve and talk. It cannot change agents or settings.

  [QR code rendered in the terminal]
```

Scan the printed code with the app's camera — the same scan-only path as the web QR. `--preset phone` needs no `--name`; a hostname-derived label is used when you omit one.

**Third, manual entry.** In the app's Connect screen, type the server URL and paste the key printed by either path above (drop `--qr` from the CLI command to print the key as plain text instead of a code).

### 3. Connect

Open the app, enter or scan the URL and key, and wait for the two connect probes: `GET /healthz` (server reachable, version compatible) and `meta.whoami` (the key is valid and shows its own name and scopes). A failed probe names the fix — a missing scope, a revoked key, or a server older than the app expects — instead of a bare "unreachable".

Plain `http` reaches the server over a LAN address without extra configuration; over a tailnet address it does too, but prefer `https` (a Tailscale HTTPS certificate, or Let's Encrypt behind a reverse proxy) when your setup makes it easy — a plain-http tailnet connection is validated only on a LAN address as of this writing, not proven against every tailnet configuration.

## What the phone can and cannot do

The phone can read, approve, steer a running turn, talk, and create a new agent only through the Architect chat. Editing `SOUL.md`, `config.yaml`, provider credentials, named secrets, backup/restore, cron scheduling, team manifests and plugin credentials stay web-only — mint a phone key and it still cannot touch any of those.

## Revoking access

Two ways, matching how you connected:

- Web: Settings → Mobile app → Connected phones → **Revoke** next to the device.
- Terminal: `ethos api-key revoke <prefix>`, where `<prefix>` is the short prefix printed by `ethos api-key create` or `ethos api-key list`.

Revoking is immediate — the phone's next call returns `UNAUTHORIZED`. It is not destructive to anything on the server; the phone just stops being able to reach it.

## Tuning the approval timeout

A tool call that needs your permission waits for an Allow/Deny before it runs. `approvalTimeoutMs` in `config.yaml` controls how long it waits before auto-denying:

```yaml
# ~/.ethos/config.yaml
approvalTimeoutMs: 1800000 # 30 minutes — recommended once approvals arrive as push
```

Left unset, each approval store falls back to its own 10-minute default. 30 minutes is the recommended value once you rely on push notifications rather than watching the app: a push can sit unread for a while, and a call that auto-denies before you have picked up your phone is a worse experience than one that waits.

## Push notifications

An approval, a clarifying question, and a few other events can reach the phone as a push notification, so you do not have to keep the app open. This is controlled by `push.transport` in `config.yaml`:

```yaml
# ~/.ethos/config.yaml
push:
  transport: expo # or: none
```

`expo` is the default. Push banners transit the Expo Push Service — the payload is minimal (an id and a category, never a tool's arguments); the extension on your phone fetches the actual approval text over your own bearer key when the banner arrives. Set `transport: none` to opt out entirely: `push.register` then stores nothing and no traffic reaches Expo.

## The Telegram approval bridge

If you also have a Telegram bot bound to Ethos, the same approval can show Approve/Deny buttons there as well as on your phone — whichever you decide on first wins, and the other surface updates to match. This bridge only runs under `ethos boot`, the merged single-process profile that runs the web-api and the gateway together. Running `ethos serve` and `ethos gateway` as two separate processes does not wire it up.

## Verify

- `ethos api-key list` shows the new key with its name, prefix and scopes.
- In the app's More → Settings, the server row shows the key's name and scope list, sourced from `meta.whoami`.
- Ask an agent to run a tool that needs approval. The lock screen shows an Allow once / Deny banner within a few seconds if push is on; otherwise the approval appears in the app itself as soon as you open it.

## Troubleshoot

**The connect screen shows "unreachable"** — the server is still bound to `127.0.0.1`. Revisit step 1; a phone cannot dial a loopback address.

**`meta.whoami` fails with a missing-scope error** — the key predates a scope the app now needs. Mint a new one with `ethos api-key create --preset phone --qr` and reconnect.

**No push arrives** — check `push.transport` is `expo`, not `none`; then check Settings → Mobile app → Connected phones for a `push · not registered` row, which means the phone has not completed its own notification permission grant yet.

**Revoking didn't stop a Telegram approval** — the two surfaces are independent decision paths on the same approval; revoking the phone key removes only the phone's ability to decide, not the Telegram bridge (see above).

## See also

- [Deploy Mission Control with a remote Ethos](deploy-mission-control-remote.md) — the same bearer-key pattern for a browser-based remote client.
- [API key scopes](../reference/api-key-scopes.md) — the full scope vocabulary a key can carry.
- [Config YAML reference](../../using/reference/config-yaml.md) — `web.host`, `webBaseUrl`, `approvalTimeoutMs` and `push.transport` in full.
