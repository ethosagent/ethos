---
title: Run Ethos in Docker
description: Run Ethos via Docker Compose with provider API keys — web UI on localhost:3000, optional gateway, config auto-generated.
kind: how-to
audience: user
slug: run-in-docker
time: 10 min
updated: 2026-05-22
---

Run Ethos via Docker Compose. Pass a provider API key, bring up the stack, and open the web UI. The `init` service auto-generates `config.yaml` on first boot so there is no interactive setup.

## Task

Run Ethos via Docker Compose with at least one provider API key.

## Result

Web UI at `http://localhost:3000`, optional channel gateway, `config.yaml` auto-generated into a named volume. Config and session data persist across restarts.

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose` subcommand, not the legacy `docker-compose` binary).
- At least one provider API key (Anthropic, OpenAI, OpenRouter, or Google).

## Quick start

```bash
ANTHROPIC_API_KEY=sk-ant-… docker compose -f docker/docker-compose.yml up
```

Open `http://localhost:3000`.

On first run the `init` service detects your provider key, writes a minimal `config.yaml` into the `ethos-data` volume, and exits. Subsequent runs skip init if the config already exists.

## Required env vars

At least one must be set. The init service uses the first one it finds, in priority order:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GOOGLE_API_KEY` | Google (Gemini) |

## Gateway opt-in

The channel gateway (Telegram, Slack, Discord, Email) is off by default. Activate it with the `gateway` profile:

```bash
ANTHROPIC_API_KEY=sk-ant-… docker compose -f docker/docker-compose.yml --profile gateway up
```

The gateway service connects to each configured channel bot and routes inbound messages to the appropriate personality. Configure channel bots in `config.yaml` inside the volume — see [config.yaml reference](../reference/config-yaml.md).

## Persisting data

The Compose file declares a named volume `ethos-data`, mounted at `/home/ethos/.ethos`. This volume holds `config.yaml`, the session database, personality data, and memory files.

The volume survives `docker compose down`. To back it up:

```bash
docker run --rm -v ethos-data:/data -v "$(pwd)":/backup alpine tar czf /backup/ethos-backup.tar.gz -C /data .
```

To restore:

```bash
docker run --rm -v ethos-data:/data -v "$(pwd)":/backup alpine tar xzf /backup/ethos-backup.tar.gz -C /data
```

:::warning
Do NOT run multiple containers sharing the same `ethos-data` volume. CronScheduler uses file-based locking and is not safe for concurrent multi-host access. `scale=1` per service is the only supported configuration. Running multiple replicas against the same volume will cause lock contention, data corruption, and undefined behaviour.
:::

## Advanced: custom config.yaml

To skip the init auto-generation, write your own `config.yaml` into the volume before the first run:

```bash
# Create the volume and populate it
docker volume create ethos-data
docker run --rm -v ethos-data:/data -v "$(pwd)":/src alpine cp /src/config.yaml /data/config.yaml
```

The `init` service is idempotent — it detects the existing config and exits immediately.

See [config.yaml reference](../reference/config-yaml.md) for every supported field.

## Advanced: manual docker run

If you prefer not to use Compose, build and run the image directly.

**Build:**

```bash
git clone https://github.com/MiteshSharma/ethos.git
cd ethos
docker build -t ethos:local -f docker/Dockerfile docker/
```

**Run:**

```bash
docker run -d --name ethos \
  --restart unless-stopped \
  -e ETHOS_MANAGED=1 \
  -e ANTHROPIC_API_KEY=sk-ant-… \
  -v ~/ethos-data:/home/ethos/.ethos \
  -p 3000:3000 \
  ethos:local
```

The resulting image runs as `ethos:1000` and exposes port 3000. `ETHOS_MANAGED=1` skips the interactive setup wizard and exits with code 2 if `config.yaml` is missing.

To run only the gateway (no web API), pass `-e ETHOS_MODE=gateway`. To run only the web API, pass `-e ETHOS_MODE=ui`.

## Kubernetes

The same pattern translates to a Deployment + ConfigMap (`config.yaml` and `mcp.json`) + Secret (`.env`) + PersistentVolumeClaim (session DB and personalities). Ethos does not ship a Helm chart today; the manifests below are the minimum a chart would template.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ethos-config
data:
  config.yaml: |
    schemaVersion: 1
    provider: anthropic
    model: claude-opus-4-7
    apiKey: ${secrets:providers/anthropic/apiKey}
    personality: researcher
    telegram.bots.0.token: ${secrets:channels/telegram/default/botToken}
    telegram.bots.0.bind.type: personality
    telegram.bots.0.bind.name: researcher
  mcp.json: |
    [{"name":"filesystem","transport":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem","/data"]}]
---
apiVersion: v1
kind: Secret
metadata:
  name: ethos-secrets
type: Opaque
stringData:
  .env: |
    ANTHROPIC_API_KEY=sk-ant-...
    TELEGRAM_BOT_TOKEN=123:ABC...
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ethos
spec:
  replicas: 1
  selector: { matchLabels: { app: ethos } }
  template:
    metadata: { labels: { app: ethos } }
    spec:
      securityContext: { fsGroup: 1000 }
      containers:
        - name: ethos
          image: ethos:local
          env:
            - { name: ETHOS_MANAGED, value: "1" }
          ports: [{ containerPort: 3000 }]
          livenessProbe:
            httpGet: { path: /healthz, port: 3000 }
            initialDelaySeconds: 10
          volumeMounts:
            - { name: config,  mountPath: /home/ethos/.ethos/config.yaml, subPath: config.yaml }
            - { name: config,  mountPath: /home/ethos/.ethos/mcp.json,    subPath: mcp.json }
            - { name: secrets, mountPath: /home/ethos/.ethos/.env,        subPath: .env }
            - { name: state,   mountPath: /home/ethos/.ethos }
      volumes:
        - { name: config,  configMap: { name: ethos-config } }
        - { name: secrets, secret:    { secretName: ethos-secrets, defaultMode: 0o600 } }
        - { name: state,   persistentVolumeClaim: { claimName: ethos-state } }
```

Build the image with `docker build -t ethos:local -f docker/Dockerfile docker/` (note: `docker/Dockerfile`, not the old `apps/ethos/Dockerfile` path).

To wrap this as a Helm chart, move the per-environment values (provider, model, image tag, channel bot lists, MCP server list) into `values.yaml` and templatise the ConfigMap and Secret bodies.

## Troubleshoot

**Container exits with code 2.** `config.yaml` is missing from the mounted volume. Confirm the bind mount target is `/home/ethos/.ethos` and `config.yaml` is at the root of that directory.

**Healthcheck fails but logs show "gateway started".** The web API failed to bind. Check whether port 3000 is in use, or set `ETHOS_MODE=gateway` to skip the web API entirely.

**Telegram bot is silent.** Inspect `docker logs ethos` for adapter errors. The most common cause is a malformed token in `.env` — the value should have the form `<digits>:<base64-ish>` and the `botKey` suffix (if any) must match the one used in `config.yaml`.

**Permission denied writing to the volume.** The mounted host directory must be owned by uid 1000. `sudo chown -R 1000:1000 ~/ethos-data` fixes this.

## See also

- [Configure providers](configure-providers.md) — swap the LLM provider without restarting.
- [Run as a daemon](run-as-daemon.md) — systemd, launchd, and pm2 alternatives.
- [config.yaml reference](../reference/config-yaml.md) — every supported field.
- [MCP config reference](../reference/mcp-config.md) — transports, OAuth, env sandboxing.
