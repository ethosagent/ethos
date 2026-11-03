---
title: "Run Ethos in Docker: healthcheck, docker run and Kubernetes"
description: "Mode-aware container healthcheck, running the Ethos image without Compose, and installing the Helm chart."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Run the Ethos image without Compose, either with `docker run` or on Kubernetes, and know which health endpoint to probe for each `ETHOS_MODE`.

## Result

A single `ethos` container (or a Helm-managed StatefulSet) serving the web UI on `http://localhost:3000`, with a healthcheck that matches its mode.

## Prereqs

- Complete [Run Ethos in Docker](../run-in-docker.md) to see the Compose path first.
- Docker 24+, or `kubectl` and `helm` with access to a cluster for the Kubernetes section.
- One provider API key.

## Steps

Read the healthcheck section, then follow either `docker run` or Kubernetes.

## Mode-aware healthcheck

The image bakes one healthcheck script (`docker-healthcheck.sh`) that probes the right endpoint for the container's `ETHOS_MODE`, so both Compose services and raw `docker run` users get a check that can actually pass.

| `ETHOS_MODE` | Probe | Serves |
|---|---|---|
| `all` | `:3000/healthz` | web UI + supervised gateway |
| `ui` | `:3000/healthz` | web UI only |
| `gateway` | `:3002/healthz` | gateway's own health server |
| `boot` (default) | `:3002/healthz` | merged scale-to-zero single-process profile — same health server as `gateway` |

A hardcoded `:3000` check could never pass in `gateway` mode — nothing listens there. The script fixes that.

Liveness is deliberate: only a definitive local failure flips a container unhealthy. A running process with an upstream outage (a Telegram blip, an adapter reporting not-ok) reports `degraded` over HTTP 503 but stays **healthy** — an upstream hiccup must not fail a fresh `compose up`. In `all` mode the check also fails if the supervised gateway's heartbeat goes stale or missing, which catches the gateway child dying while the web process stays up. This chains the existing gateway heartbeat — it is not a second health mechanism.

For readiness rather than liveness — a Kubernetes `readinessProbe`, or a load balancer deciding whether to route to a replica — `gateway` and `boot` also serve `:3002/readyz`. It returns 503 when any adapter reports not-ok, when any of `sessions.db`, `delivery-ledger.db`, `inbound-dedup.db` or `inbound-spool.db` will not open read-only, or when the event loop's p99 delay is over one second, and lists each check in the JSON body (`createReadinessCheck` in [health-server.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/health-server.ts)). Adapter health is cached for 60 seconds, so a probe never costs an adapter round trip such as an IMAP login. The baked healthcheck stays on `/healthz`: a 503 from `/readyz` means "do not route to me", not "restart me".

## Advanced: manual docker run

If you prefer not to use Compose, run the image directly. Both services bind to `127.0.0.1` inside the container by default, so you must set `ETHOS_WEB_HOST=0.0.0.0` (web dashboard, port 3000) and `ETHOS_SERVE_HOST=0.0.0.0` (the `run-all` health server, port 3004) for `-p` to reach them from the host.

That non-loopback bind means the same first-visit token-exchange step from [Quick start](../run-in-docker.md#quick-start-single-service) applies here too — watch `docker logs ethos` for the `open: http://localhost:3000/auth/exchange?t=<token>` line and visit that URL before the bare one.

### Option A — run the published image (recommended)

```bash
docker run -d --name ethos \
  --restart unless-stopped \
  -e ETHOS_MANAGED=1 \
  -e ETHOS_WEB_HOST=0.0.0.0 \
  -e ETHOS_SERVE_HOST=0.0.0.0 \
  -e ANTHROPIC_API_KEY=sk-ant-… \
  -v ethos-data:/home/ethos/.ethos \
  -p 3000:3000 \
  ethosagent/ethos:latest
```

`ethosagent/ethos:latest` always tracks the newest published release, so no version pinning is needed. To pin a specific version, use `ethosagent/ethos:<version>` (for example `ethosagent/ethos:0.4.18`).

### Option B — build from source then run

```bash
git clone https://github.com/ethosagent/ethos.git
cd ethos
docker build -t ethos:local -f docker/Dockerfile docker/
```

```bash
docker run -d --name ethos \
  --restart unless-stopped \
  -e ETHOS_MANAGED=1 \
  -e ETHOS_WEB_HOST=0.0.0.0 \
  -e ETHOS_SERVE_HOST=0.0.0.0 \
  -e ANTHROPIC_API_KEY=sk-ant-… \
  -v ethos-data:/home/ethos/.ethos \
  -p 3000:3000 \
  ethos:local
```

The image runs as `ethos:1000` and exposes port 3000. `ETHOS_MANAGED=1` skips the interactive setup wizard and exits with code 2 if `config.yaml` is missing.

To run only the gateway (no web API), pass `-e ETHOS_MODE=gateway`. To run only the web API, pass `-e ETHOS_MODE=ui`.

The image's default when `ETHOS_MODE` is unset — as in Option A/B's commands above — is now `boot`, not `all`. `boot` still gives a talking web UI at the same `:3000`, just via the merged single-process profile rather than two supervised subprocesses. Pass `-e ETHOS_MODE=all` to opt back into the two-subprocess topology with independent crash isolation.

## Kubernetes

Ethos ships a first-party Helm chart at [`helm/ethos`](https://github.com/ethosagent/ethos/tree/main/helm/ethos) in the repo. It is the supported Kubernetes path — do not hand-write manifests. The chart is not yet published to a chart registry; install it from a clone of the repo.

Create a Secret holding your provider key, install the chart against it, then port-forward to reach the UI:

```bash
kubectl create secret generic ethos-keys --from-literal=ANTHROPIC_API_KEY=sk-ant-…
helm install ethos ./helm/ethos --set existingSecret=ethos-keys
kubectl port-forward svc/ethos 3000
```

```
Forwarding from 127.0.0.1:3000 -> 3000
```

Open `http://localhost:3000`. The same first-visit token exchange from [Quick start](../run-in-docker.md#quick-start-single-service) applies — watch `kubectl logs ethos-0` for the `open: .../auth/exchange?t=<token>` line. To keep the token out of pod logs, set the chart's `webAuth.bootstrapToken.existingSecret` (and optionally `key`) values: they inject the token from a pre-created Secret as `ETHOS_WEB_TOKEN` (at least 24 characters), the URL is then never printed, and you sign in by pasting the token — or claim the instance at `/welcome` with a username and password.

The chart handles what the raw-manifest approach gets wrong. It deploys a single-replica StatefulSet — the gateway singleton lock means a second pod exits with code 3, so there is no scaling knob to misuse. A persistent volume at `/home/ethos/.ethos` holds `config.yaml` and the databases; `config.yaml` is rewritten at runtime (secret re-sync, web UI settings), which is why it must **not** be mounted from a ConfigMap — earlier versions of this page advised exactly that, and it breaks every runtime write. First boot self-provisions from env (`ethos setup --from-env`, the same provisioning the Compose files run), health probes hit the gateway's health server on `:3002`, a NetworkPolicy is on by default, and no Kubernetes API token is mounted into the pod.

For real clusters, start from the overlays in [`helm/ethos/examples/`](https://github.com/ethosagent/ethos/tree/main/helm/ethos/examples): EKS (ALB + EBS + IRSA), nginx + cert-manager, and a minimal profile. The [chart README](https://github.com/ethosagent/ethos/tree/main/helm/ethos) covers the full values reference, network security notes, and the backup/restore (`ethos import`) runbook.

## Verify

```bash
docker inspect --format '{{.State.Health.Status}}' ethos
```

```
healthy
```

On Kubernetes, after `kubectl port-forward svc/ethos 3000`, `curl -fsS http://localhost:3000/healthz` returns `{"status":"ok",...}`.

## Troubleshoot

**Healthcheck fails but logs show "gateway started".** The web API failed to bind. Check whether port 3000 is in use, or set `ETHOS_MODE=gateway` to skip the web API entirely.

## See also

- [Run Ethos in Docker](../run-in-docker.md) — Compose quick start.
- [Run as a daemon](../run-as-daemon.md) — systemd, launchd, and pm2 alternatives.
