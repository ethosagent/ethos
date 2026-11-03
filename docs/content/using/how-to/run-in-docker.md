---
title: Run Ethos in Docker
description: Run Ethos via Docker Compose — one API key and one command for a talking web UI on localhost:3000, or the three-service operator topology.
kind: how-to
audience: user
slug: run-in-docker
time: 10 min
updated: 2026-11-03
---

Run Ethos via Docker Compose. Set one provider API key, run one command, and get a web UI you can talk to. Config is provisioned by the CLI (`ethos setup --from-env`), which validates your key before writing it — no interactive setup, no hand-edited YAML.

## Task

Run Ethos via Docker Compose with at least one provider API key.

## Result

Web UI at `http://localhost:3000` that opens directly in chat, config validated and written into a named volume. Config and session data persist across restarts.

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose` subcommand, not the legacy `docker-compose` binary).
- At least one provider API key (Anthropic, OpenAI, OpenRouter, Google, or Azure).

The shipped image does **not** include `ffmpeg`. Everything except spoken replies on channels works without it; to get those, add `ffmpeg` to the runtime stage of `docker/Dockerfile` (`apt-get install -y --no-install-recommends ffmpeg`) and rebuild. Without it the gateway still starts, prints a `⚠ ffmpeg not found` notice, and delivers voice notes only in formats the TTS provider already emits — see [Send and receive voice notes on a channel](voice-notes-on-channels.md).

## Parts

| Part | Covers |
|---|---|
| This page | Quick start, three-service topology, verify, first-boot troubleshooting |
| [Configuration and data](run-in-docker/configuration.md) | Required env vars, gateway opt-in, the `ethos-data` volume, backup, custom `config.yaml` |
| [Healthcheck, docker run and Kubernetes](run-in-docker/healthcheck-run-kubernetes.md) | Mode-aware healthcheck, running the image without Compose, the Helm chart |

## Steps

Pick one profile: the single service for a first run, the three services for an operator setup.

## Quick start (single service)

The single-service profile is the fastest path: one service, one volume, one command. Put a key in `.env` next to the compose file, then bring it up.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-…" > docker/.env
docker compose -f docker/docker-compose.single.yml up
```

Watch for two lines in the boot output: `✓ Config validated` from provisioning, then an `open:` line printed shortly after by the `serve` sub-process.

```
✓ Config validated — web UI: http://localhost:3000
...
  open: http://localhost:3000/auth/exchange?t=<token>
```

Open that `auth/exchange` URL first, not the bare `http://localhost:3000`. `docker-compose.single.yml` binds the web server to `0.0.0.0`, which marks the auth cookie `Secure` — the browser can only get it by exchanging the token. This is one-time: the exchange sets the cookie and redirects to `/`, and the bare URL works on every visit after that as long as the volume and cookie aren't cleared.

Token mode is the default steady state — nothing forces you past it. Optionally, claim the instance at `http://localhost:3000/welcome` (enter the token, set a username and password); after that the exchange URL stops signing browsers in and instead opens the reset form at `/welcome/reset` with the token prefilled, and the web UI asks for the username and password.

The provider key from `.env` is never re-asked once validated and written — but that's separate from the token exchange above, which is still required on the first visit. Type a message and the first reply streams back.

At boot the entrypoint runs `ethos setup --from-env` (gated by `ETHOS_PROVISION_FROM_ENV=1`): it validates the provider key, writes `config.yaml` into the volume once, and re-syncs secrets from `.env` on every restart. A rejected key (401) stops the boot with an actionable final line — for example `ANTHROPIC_API_KEY rejected (401) — check the key in .env and re-run docker compose up`.

## Three-service topology (operators)

For separate web and gateway processes — the operator setup — use the three-service compose file. It runs a one-shot `init` service, then long-running `ethos-web` (port 3000) and `ethos-gateway` services.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-…" > docker/.env
docker compose -f docker/docker-compose.yml up
```

The `init` service runs the same `ethos setup --from-env` provisioning, validates the key, writes `config.yaml`, then exits. Both runtime services wait for it (`depends_on: service_completed_successfully`) so they never start against a missing config. Subsequent runs re-sync secrets from `.env` and preserve any edits you made to `config.yaml` in the volume.

## Verify

```bash
curl -fsS http://localhost:3000/healthz
# {"status":"ok","uptime":42.1}
```

Check the init service exited cleanly:

```bash
docker compose -f docker/docker-compose.yml ps init
# State should be "exited (0)"
```

## Troubleshoot

**Container exits with code 2.** `config.yaml` is missing from the mounted volume. Confirm the mount target is `/home/ethos/.ethos` and `config.yaml` is at the root of that directory.

**Web UI loads but API calls return 401 Unauthorized.** You opened the bare `http://localhost:3000` before ever visiting the `open: .../auth/exchange?t=<token>` URL from the boot output. Open that exact URL once — it sets the auth cookie — then the bare URL works normally on subsequent visits. If you have claimed the instance (set a username and password), that URL no longer signs you in — use the login screen, or `/welcome/reset` with the token if the password is lost.

## See also

- [Configure providers](configure-providers.md) — swap the LLM provider without restarting.
- [Run as a daemon](run-as-daemon.md) — systemd, launchd, and pm2 alternatives.
- [config.yaml reference](../reference/config-yaml.md) — every supported field.
- [MCP config reference](../reference/mcp-config.md) — transports, OAuth, env sandboxing.
