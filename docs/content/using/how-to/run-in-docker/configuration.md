---
title: "Run Ethos in Docker: configuration and data"
description: "Provider env vars, gateway profile, the ethos-data volume and backup, and a custom config.yaml for Docker deployments."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Set the provider and channel environment for the Ethos containers, enable the gateway, and keep `config.yaml` and session data in a volume you can back up.

## Result

Compose provisions `config.yaml` from your env vars, the gateway runs when you ask for it, and `ethos-data` holds state that survives `docker compose down` and can be backed up and restored.

## Prereqs

- Complete [Run Ethos in Docker](../run-in-docker.md) so the stack boots.
- Docker 24+ with Compose v2.

## Steps

Read the env var table first, then apply the sections you need.

## Required env vars

At least one must be set. `ethos setup --from-env` uses the first one it finds, in priority order:

| Variable | Provider | Notes |
|---|---|---|
| `AZURE_API_KEY` | Azure OpenAI | requires `AZURE_ENDPOINT`; optional `AZURE_OUTPUT_CAP_PARAM` (`max_tokens` or `max_completion_tokens`) provisions `providers.0.outputCapParam` — set `max_completion_tokens` for a reasoning model deployed under a non-family name; any other value stops the boot |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | — |
| `OPENAI_API_KEY` | OpenAI | — |
| `OPENROUTER_API_KEY` | OpenRouter | — |
| `GOOGLE_API_KEY` | Google (Gemini) | — |

Set `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_OWNER_ID`) to provision a Telegram bot in the same pass. Tokens are validated before they are written: a rejected token (401) stops the boot; an unreachable endpoint is saved unverified with a warning. Set `ETHOS_SKIP_VALIDATION=1` to bypass all probes on air-gapped boots.

## Gateway opt-in

The channel gateway (Telegram, Slack, Discord, Email) is off by default. Activate it with the `gateway` profile:

```bash
ANTHROPIC_API_KEY=sk-ant-… docker compose -f docker/docker-compose.yml --profile gateway up
```

The gateway service connects to each configured channel bot and routes inbound messages to the appropriate personality. Configure channel bots in `config.yaml` inside the volume — see [config.yaml reference](../../reference/config-yaml.md).

## Persisting data

Both Compose files declare a named volume `ethos-data`, mounted at `/home/ethos/.ethos`. This volume holds `config.yaml`, the session database, personality data, and memory files.

:::warning Keep state off Docker Desktop bind mounts
On Docker Desktop (macOS and Windows), a host directory mounted into the container is a virtiofs or gRPC-FUSE mount (macOS) or a 9p mount (Windows). SQLite's file locking is not reliable on those filesystems, and the databases in the state directory can corrupt. Keep the default named volume there. `ethos doctor` inside the container warns under **Data directory** when the state directory sits on FUSE, 9p, NFS or SMB (`checkStateDirFilesystem` in [`apps/ethos/src/commands/doctor.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/doctor.ts)).
:::

If you run native Docker on Linux and want the state in a host directory, set `ETHOS_DATA_DIR` in `docker/.env` to its path. Compose then bind-mounts that path instead of the volume.

### Move an existing `ethos-data/` folder into the volume

Before this release both Compose files bind-mounted a host folder (`../ethos-data` for `docker-compose.yml`, `docker/ethos-data` for the single-service file). If you have one and have not set `ETHOS_DATA_DIR`, copy it into the volume once. From the `docker/` folder, with the stack stopped:

```bash
docker compose -f docker-compose.single.yml run --rm --no-deps --user root \
  -v "$(pwd)/ethos-data:/from:ro" --entrypoint sh ethos \
  -c 'cp -a /from/. /home/ethos/.ethos/ && chown -R 1000:1000 /home/ethos/.ethos'
```

For `docker-compose.yml`, run the same command against the `init` service with `-f docker-compose.yml` and `-v "$(pwd)/../ethos-data:/from:ro"`. To keep the bind mount instead, set `ETHOS_DATA_DIR=../ethos-data` (or `./ethos-data`) in `docker/.env`.

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

See [config.yaml reference](../../reference/config-yaml.md) for every supported field.

## Verify

```bash
docker run --rm -v ethos-data:/data alpine ls /data
```

The listing includes `config.yaml`. If it is empty, the stack has not booted against this volume yet.

## Troubleshoot

**Telegram bot is silent.** Inspect `docker logs ethos` for adapter errors. The most common cause is a malformed token in `.env` — the value should have the form `<digits>:<base64-ish>` and the `botKey` suffix (if any) must match the one used in `config.yaml`.

**Permission denied writing to the volume.** If you bind-mount a host directory (`ETHOS_DATA_DIR`), it must be owned by uid 1000. `sudo chown -R 1000:1000 ~/ethos-data` fixes this.

**`ethos doctor` warns the state directory is on fuse, 9p, nfs or smb.** The state directory is a bind mount on a filesystem where SQLite locking is unsafe. Unset `ETHOS_DATA_DIR` to use the `ethos-data` named volume, and move the data with the command in [Move an existing `ethos-data/` folder into the volume](#move-an-existing-ethos-data-folder-into-the-volume).

## See also

- [config.yaml reference](../../reference/config-yaml.md) — every supported field.
- [Run Ethos in Docker](../run-in-docker.md) — quick start and verify.
