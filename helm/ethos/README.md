# Ethos Helm chart

Deploys a single-pod [Ethos](https://github.com/ethosagent/ethos) agent: web UI + API on `:3000`, gateway with channel adapters, all state on one volume. The core chart is provider-agnostic (default StorageClass, RWO, standard `networking.k8s.io/v1` Ingress); cloud specifics live in overlays under `examples/`.

**Architecture:** one StatefulSet with `replicas` hardcoded to 1, a volumeClaimTemplate mounted at `/home/ethos/.ethos` (config, secret vault, personalities, SQLite databases, OAuth tokens, in-app backups — the PVC outlives `helm uninstall`), a ClusterIP Service publishing `:3000` plus a headless Service for the StatefulSet, and an optional Ingress. The container runs `ETHOS_MODE=boot` and self-provisions from env on first start.

## Install

Create the key Secret once, then pick an overlay:

```sh
kubectl create secret generic ethos-keys --from-literal=ANTHROPIC_API_KEY=sk-ant-...
```

| Target | Command |
|---|---|
| kind / k3s / minikube | `helm install ethos ./helm/ethos -f helm/ethos/examples/values-minimal.yaml --set-string secrets.ANTHROPIC_API_KEY=sk-ant-...` |
| Any cluster with nginx + cert-manager | `helm install ethos ./helm/ethos -f helm/ethos/examples/values-nginx-certmanager.yaml` |
| EKS with ALB + EBS + IRSA | `helm install ethos ./helm/ethos -f helm/ethos/examples/values-eks-alb-ebs.yaml` |

Each overlay's header comments list its cluster prerequisites and placeholders. The minimal overlay needs no pre-created Secret — it passes the key via `--set-string`.

### Web auth bootstrap

`webAuth.bootstrapToken.existingSecret` sets the web-auth bootstrap token (env `ETHOS_WEB_TOKEN`, ≥24 chars) from a pre-created Secret, so you never need pod exec to retrieve it. When set, the app does not print the auth URL to its logs — the operator already holds the token.

```sh
kubectl create secret generic ethos-web-token --from-literal=ETHOS_WEB_TOKEN=$(openssl rand -hex 32)
helm install ethos ./helm/ethos --set webAuth.bootstrapToken.existingSecret=ethos-web-token ...
```

## Values

See `values.yaml` for the full commented reference. The key groups:

| Group | Default | What it does |
|---|---|---|
| `image.repository` / `image.tag` / `image.pullPolicy` | `ethosagent/ethos` / `""` / `IfNotPresent` | Empty tag deploys `Chart.AppVersion` — the one literal the release flow bumps |
| `persistence.storageClass` / `size` / `accessModes` / `annotations` | `""` (cluster default) / `10Gi` / `[ReadWriteOnce]` / `helm.sh/resource-policy: keep` | The state PVC at `/home/ethos/.ethos`; kept on uninstall (Retain retention) |
| `workspace.persistence.enabled` | `false` | `/home/ethos/workspace` is scratch emptyDir; enable for a second PVC |
| `existingSecret` / `secrets` | `""` / `{}` | Pre-created Secret injected as env (preferred), or inline `ENV-NAME: value` the chart renders into its own Secret |
| `webAuth.bootstrapToken.existingSecret` / `key` | `""` / `ETHOS_WEB_TOKEN` | Web-auth bootstrap token from a Secret (`ETHOS_WEB_TOKEN`, ≥24 chars); empty = the app generates its token file as today |
| `service.type` / `service.port` | `ClusterIP` / `3000` | Publishes only `:3000`; `:3002` added only with the ServiceMonitor, webhook ports only with `webhooks.enabled` |
| `webhooks.enabled` / `webhookPort` / `platformWebhookPort` / `ingressPaths` | `false` / `3003` / `3006` / `/webhooks`, `/platform-webhooks` | Opens webhook ports on container, Service and NetworkPolicy; see Webhooks below |
| `ingress.enabled` / `className` / `annotations` / `hosts` / `tls` | `false` / `""` / `{}` / `[]` / `[]` | Standard v1 Ingress; hosts are plain strings; enabling it also derives `ETHOS_TRUST_PROXY=1` and `ETHOS_ALLOWED_ORIGINS` from `hosts` |
| `networkPolicy.enabled` / `ingress.from` / `monitoring.from` / `egress.mode` / `egress.cidrs` | `true` / `[]` / `[]` / `open` / `[]` | Default-on; only declared Service ports reachable from pods; `monitoring.from` required for scraping; egress open by default |
| `metrics.serviceMonitor.enabled` / `interval` / `auth.existingSecret` / `auth.key` | `false` / `30s` / `""` / `""` | Renders only when enabled AND the `monitoring.coreos.com/v1` CRDs exist; scrapes with a `metrics:read` bearer key |
| `resources` | `250m`/`512Mi` requests, `1Gi` memory limit | No CPU limit — throttling a streaming agent buys nothing; scale up for multi-bot |
| `startupProbe` / `livenessProbe` / `readinessProbe` | all `tcpSocket` on `:3002` | Full probe objects passed through verbatim — overridable |
| `preStopSleepSeconds` / `terminationGracePeriodSeconds` | `0` / `60` | SIGTERM drain is ~37s worst case |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}` | Standard scheduling passthrough |
| `serviceAccount` / `extraEnvVars` / `podAnnotations` / `podLabels` | create, no annotations / `{}` | ServiceAccount exists only for workload-identity annotations (IRSA); `extraEnvVars` maps render as `value` or `valueFrom` |

## Why one replica

There is deliberately no `replicaCount`. Ethos holds a gateway singleton lock per state directory — a second process exits with code 3 — and its state is single-writer SQLite on an RWO volume. A second pod would not scale the agent; it would fail to start, or corrupt state if it could. Scale **vertically**: raise `resources` for heavier multi-bot deployments.

## Network security

Three layers, each honest about what it covers:

**The chart enforces:**
- No Kubernetes API token in the pod — `automountServiceAccountToken: false` on both the pod and the ServiceAccount.
- Default-on NetworkPolicy: only declared Service ports are reachable from other pods. `:3001` (ACP) and `:3002` (health/metrics) get no rule; kubelet probes bypass NetworkPolicy so `:3002` probes keep working.
- The Service and Ingress publish `:3000` only — never `/metrics`, never the health port — unless you flip the metrics/webhook toggles.
- Scrape-conflict render guard: `metrics.serviceMonitor.enabled` with `networkPolicy.monitoring.from` empty **fails the render** rather than deploying a scrape target the chart's own policy silently blocks.
- Conservative env wiring: `ETHOS_TRUST_PROXY` and `ETHOS_ALLOWED_ORIGINS` (pinned to exactly the ingress hosts) are set only when ingress is enabled.

**The app enforces:** per-tool scoped-fetch host allowlists (`capabilities.network.allowedHosts`), bearer-key-protected `/metrics` (`ethos api-key create --scopes metrics:read`), and the outbound-media symlink guard.

**The cluster must supply:** a CNI that actually enforces NetworkPolicy (the object is inert otherwise — harmless, but not protection), etcd encryption at rest for Secrets, and volume encryption (e.g. EBS gp3 `encrypted: true` — see the EKS overlay).

**Egress honesty:** egress is open by default — the agent must reach LLM providers, chat platforms, OAuth endpoints and tool-fetched URLs. `networkPolicy.egress.mode: restricted` allows DNS plus TCP 443 to listed CIDRs, but CIDR allowlists for SaaS APIs are brittle (rotating IPs) — opt in knowingly. FQDN-based egress needs a CNI CRD; the EKS overlay comments show the CiliumNetworkPolicy pattern.

## Backups & disaster recovery

**In-app (on by default):** Ethos's scheduler archives daily at 4am onto the state volume, keeping 7 (config keys `backup.enabled`, `backup.cron`, `backup.keep`, `backup.scope`, `backup.dir` in the volume's `config.yaml`). No chart CronJob — a second scheduler racing the in-app one buys nothing.

**Off-volume copy:** the daily archives live on the same PVC they protect, so snapshot the volume: on EKS, opt the volume into a DLM daily-snapshot policy (tag `Snapshot=true` — see the EKS overlay); elsewhere, use `VolumeSnapshot` with your CSI driver.

**Restore an archive:**
1. Fresh `helm install` (same overlay).
2. Get the archive into the pod: `kubectl cp ethos-backup.tar.gz ethos-0:/tmp/` — or mount the restored snapshot volume and copy from it.
3. `kubectl exec ethos-0 -- ethos import /tmp/ethos-backup.tar.gz`
4. Restart the pod: `kubectl delete pod ethos-0` (the StatefulSet recreates it).

**Restore the whole volume:** create a PVC from the snapshot (`dataSource` on a new PVC), name it to match the StatefulSet's volumeClaimTemplate claim (`state-<fullname>-0`) before installing, and the release binds to it instead of provisioning fresh.

## First boot & troubleshooting

- **Self-provisioning:** the chart sets `ETHOS_PROVISION_FROM_ENV=1`; a fresh volume runs `ethos setup --from-env` from the injected Secret. Later boots keep the volume's `config.yaml`; secrets re-sync from env on every start.
- **CrashLoop right after install:** almost always no provider key in the Secret. `kubectl logs ethos-0` names the missing variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). Fix the Secret, delete the pod.
- **Web UI 401 on first visit:** open the `auth/exchange?t=<token>` URL from `kubectl logs ethos-0`, not the bare `http://localhost:3000`. One-time — it sets the auth cookie.
- **Probes:** all three default to a TCP check on `:3002` (process up). Not `:3002/healthz`: it reports 503 whenever no channel adapter is configured — exactly the chart's minimal web-only install — so an httpGet probe there could never pass. `/readyz` is deliberately NOT the readiness probe either — with one replica it would turn any platform-adapter outage into a UI outage. Operators running channel adapters can override any probe with `httpGet /healthz` (gateway-status-coupled) or `/readyz` (strict). Diagnostics: `kubectl exec ethos-0 -- curl -s localhost:3002/readyz`.
- **SSE streams die mid-answer:** your edge's idle timeout. The nginx overlay sets `proxy-read-timeout`; the EKS overlay sets the ALB `idle_timeout` attribute.

## Webhooks

Channel platforms in webhook mode call Ethos **from the internet**. Webhook routes render only when `webhooks.enabled` AND `ingress.enabled` are BOTH set — either toggle off renders no route — and require a public host with TLS at the edge. Polling adapters (the default for e.g. Telegram) need none of this.
