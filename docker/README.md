# docker/

Reference for the Docker packaging and Compose setup.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: installs `@ethosagent/cli` from npm in a build stage, then copies into a clean `node:24-slim` runtime image. Runs as uid 1000 (`ethos`), exposes port 3000. |
| `docker-entrypoint.sh` | Reads `ETHOS_MODE` and execs the corresponding Ethos command (`run-all`, `gateway start`, or `serve`). |
| `.dockerignore` | Excludes `.git`, `node_modules`, `plan/`, `docs/`, tests, and dist from the build context. |
| `docker-compose.yml` | Three-service Compose stack described below. |

## Compose services

| Service | Role | Lifecycle |
|---|---|---|
| `init` | One-shot bootstrap. Detects the first set provider key, writes `config.yaml` into the `ethos-data` volume. Exits after writing (or immediately if config already exists). | Runs once, `restart: "no"`. |
| `ethos-web` | Web UI on port 3000. Waits for `init` to complete before starting. Read-only root filesystem. | Always-on, `restart: unless-stopped`. |
| `ethos-gateway` | Channel gateway (Telegram, Slack, Discord, Email). Activated only with `--profile gateway`. Read-only root filesystem. | Always-on when activated, `restart: unless-stopped`. |

Both `ethos-web` and `ethos-gateway` depend on `init` via `condition: service_completed_successfully`.

## Required env vars

At least one provider API key must be set:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GOOGLE_API_KEY` | Google (Gemini) |

The `init` service checks them in the order listed above and uses the first one found.

## Optional env vars

| Variable | Default | Description |
|---|---|---|
| `ETHOS_STATE_DIR` | `/home/ethos/.ethos` | Path inside the container where Ethos stores config, sessions, and personality data. |
| `ETHOS_MODE` | `all` | Which process the entrypoint starts. Values: `all` (web + gateway), `ui` (web only), `gateway` (gateway only). Set per-service in the Compose file; override only if you know what you're doing. |

## Quick start

**Web UI only:**

```bash
ANTHROPIC_API_KEY=sk-… docker compose -f docker/docker-compose.yml up
```

**Web UI + gateway:**

```bash
ANTHROPIC_API_KEY=sk-… docker compose -f docker/docker-compose.yml --profile gateway up
```

**Rebuild after version bump:**

```bash
docker compose -f docker/docker-compose.yml pull && docker compose -f docker/docker-compose.yml up
```

## Custom state directory

Set `ETHOS_STATE_DIR` to change where Ethos writes data inside the container. You must also update the volume mount to match:

```yaml
# In docker-compose.yml, under each service's volumes:
volumes:
  - ethos-data:/your/custom/path
```

Pass the env var to all three services (init, ethos-web, ethos-gateway).
