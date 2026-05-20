---
title: Run Ethos in Docker
description: Deploy Ethos in Docker or Kubernetes with credentials, channels, and MCP servers configured via mounted files at boot — no UI, no interactive setup.
kind: how-to
audience: user
slug: run-in-docker
time: 15 min
updated: 2026-05-20
---

Deploy Ethos as a long-running container where every piece of configuration — provider keys, channel bots, MCP servers — is baked into mounted files before the process starts. Edit a file, redeploy, and the change goes through the same path every time. The container never enters interactive mode, the web UI is optional, and config drift is auditable.

This how-to walks the Docker single-host case end to end, then translates the same pattern to a Kubernetes ConfigMap + Secret + Deployment. Use [Run as a daemon](run-as-daemon.md) instead if you're on a bare Linux host without a container runtime.

## Task

Run Ethos as a long-running container with `config.yaml`, `.env`, and `mcp.json` mounted from the host (or a ConfigMap + Secret in Kubernetes), so credentials, channel bots, and MCP servers are configured at boot without interactive setup or the web UI.

## Result

A container (or Pod) that comes up clean, exposes `/healthz` on port 3000, answers messages on the configured Telegram and Slack bots, and exposes each personality's allowed MCP servers — all driven from files you edit and redeploy.

## Prerequisites

- Docker 24+ (or Podman) for the local path. `kubectl` against a cluster for the Kubernetes path.
- A provider API key (Anthropic, OpenAI, etc.).
- The bot tokens for each channel you intend to wire (Telegram, Slack, Discord, Email).
- The command or URL for each MCP server you want available, plus any environment variables it needs.

## 1. Build the image

Ethos does not publish an official image yet ([deploy-in-production.md](deploy-in-production.md) tracks this). Build one from the repo:

```bash
git clone https://github.com/MiteshSharma/ethos.git
cd ethos
docker build -t ethos:local -f apps/ethos/Dockerfile .
```

The resulting image runs as `ethos:1000` and exposes port 3000.

## 2. Prepare the host volume

Ethos persists everything under `/home/ethos/.ethos` in the container. Mount a host directory or a named volume there.

```bash
mkdir -p ~/ethos-data
sudo chown -R 1000:1000 ~/ethos-data
```

The mounted directory must be writable by uid 1000.

## 3. Write `config.yaml`

Create `~/ethos-data/config.yaml`. Reference secrets via `${secrets:...}`; the values themselves come from `.env` in the next step.

```yaml
schemaVersion: 1
provider: anthropic
model: claude-opus-4-7
apiKey: ${secrets:providers/anthropic/apiKey}
personality: researcher
memory: markdown
```

See [config.yaml reference](../reference/config-yaml.md) for every supported field.

## 4. Write `.env` with credentials

Create `~/ethos-data/.env` (mode 0600). The env-loader recognises a closed set of variable names and maps each to its internal secret ref:

```env
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

`.env` is the highest-precedence source. On-disk files under `~/.ethos/secrets/<ref>` (mode 0600) are the lowest-precedence fallback for any value not in `.env`.

For multi-bot setups, append the bot key to the variable name: `TELEGRAM_BOT_TOKEN_researcher=...` maps to `channels/telegram/researcher/botToken`.

## 5. Add a Telegram bot

Append to `config.yaml`:

```yaml
telegram.bots.0.token: ${secrets:channels/telegram/default/botToken}
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher
```

For multiple bots, add `telegram.bots.1.*`, `telegram.bots.2.*`, each with its own `bind.type` (`personality` or `team`), `bind.name`, and an optional stable `id`. Each bot's token comes from `TELEGRAM_BOT_TOKEN_<botKey>` in `.env`.

## 6. Add a Slack workspace

Slack needs three credentials per workspace (bot token, app token for Socket Mode, signing secret). Append:

```yaml
slack.apps.0.botToken: ${secrets:channels/slack/default/botToken}
slack.apps.0.appToken: ${secrets:channels/slack/default/appToken}
slack.apps.0.signingSecret: ${secrets:channels/slack/default/signingSecret}
slack.apps.0.bind.type: personality
slack.apps.0.bind.name: researcher
```

See [Slack platform reference](../../platforms/slack.md) for app creation, OAuth scopes, and Socket Mode setup.

## 7. Add an MCP server

MCP servers live in `~/ethos-data/mcp.json` — JSON, not YAML. The file is read at boot by the MCP loader:

```json
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "command": "npx",
    "args": ["@modelcontextprotocol/server-filesystem", "/data"],
    "env": {},
    "mcpEnvPassthrough": ["PATH"]
  }
]
```

Each [personality](../../getting-started/glossary.md) opts in via its own `~/ethos-data/personalities/<id>/config.yaml`:

```yaml
mcp_servers:
  - filesystem
```

Servers not listed by a personality are invisible to it — the allowlist is mandatory, not advisory. See [MCP config reference](../reference/mcp-config.md) for HTTP transports, OAuth, and env sandboxing.

## 8. Run the container

```bash
docker run -d --name ethos \
  --restart unless-stopped \
  -e ETHOS_MANAGED=1 \
  -v ~/ethos-data:/home/ethos/.ethos \
  -p 3000:3000 \
  ethos:local
```

`ETHOS_MANAGED=1` tells Ethos to skip the interactive setup wizard and exit code 2 if `config.yaml` is missing. The default entrypoint runs `ethos run-all`, which supervises both the channel gateway and the web API.

To run only the gateway (no web API), pass `-e ETHOS_MODE=gateway`. To run only the web API, pass `-e ETHOS_MODE=ui`.

## Verify

```bash
curl -fsS http://localhost:3000/healthz
# {"status":"ok","uptime":42.1}

docker logs ethos | grep -i "gateway\|adapter"
# expect: gateway started, telegram adapter listening, slack adapter listening
```

Send a DM to the configured Telegram bot. The reply should arrive within a few seconds.

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
