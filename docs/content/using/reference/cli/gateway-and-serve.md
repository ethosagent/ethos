---
title: "CLI: gateway, listen, cron, serve and status commands"
description: "ethos gateway, listen, cron, acp, serve and status commands."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Commands that run Ethos as a long-lived process. Part of the [CLI reference](../cli.md).

## ethos gateway {#ethos-gateway}

Configure and run the multi-platform message [gateway](../../../getting-started/glossary.md#gateway) — the surface that brings Telegram, Slack, Discord, WhatsApp, and Email senders into the same agent.

Synopsis: `ethos gateway [setup | start | status [--json] | spool <replay|discard> <id>]`

`setup` opens the setup wizard at the messaging step (alias for `ethos setup messaging`). `start` spins up every platform whose credentials are present in [`config.yaml`](../config-yaml.md) and is long-running; exits non-zero if `~/.ethos/config.yaml` is absent. If the config has parse errors or a bot binding that resolves to no personality or team, `start` (and `ethos boot`) prints them, suggests `ethos doctor`, and exits `78` (`CONFIG_INVALID_EXIT_CODE`), which the generated systemd unit does not restart. Source: [`apps/ethos/src/lib/config-exit.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/config-exit.ts). `start` also exits `78` when every adapter fails because the platform refused its token (`adapterStartFailureExitCode` in `apps/ethos/src/commands/gateway.ts`), and exits `1` when every adapter fails for any other reason. `ethos boot` never exits for adapter failures: it keeps the web UI, cron and serve running and retries the adapters that failed transiently.

`start` takes the gateway lock, `<ethos home>/gateway.lock`, before it opens any store: one gateway per Ethos home (`ETHOS_STATE_DIR` scopes it, so two homes on one machine run two gateways). `ethos boot` owns channel adapters too and takes the same lock, so a `start` and a `boot` exclude each other. A second `start` or `boot` against a home whose gateway is alive prints the refusal and exits `3`. A lock left by a process that is gone is taken over. Source: [`packages/wiring/src/gateway-lock.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/gateway-lock.ts).

```
Another Ethos gateway is already running for /home/me/.ethos (pid 4242). Stop that process, or check it with 'ethos gateway status'. If no such process exists, remove /home/me/.ethos/gateway.lock.
```

### ethos gateway status {#ethos-gateway-status}

Read the gateway lock and heartbeat without touching either. Source: [`apps/ethos/src/commands/gateway-status.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway-status.ts).

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | boolean | off | Print `{ state, pid, heartbeatAgeMs, lockPath, spool, ledger }` on one line. `spool` and `ledger` are per-status counts, or `null` when that database does not exist yet. |

| Output | Exit code | Meaning |
|---|---|---|
| `running (pid N, heartbeat 4s ago)` | `0` | A live process holds the lock and wrote a heartbeat in the last 30 s. |
| `stale lock (pid N not running) — next start will take it over` | `1` | The lock names a process that is gone. |
| `stopped` | `1` | No lock. |
| `unhealthy (pid N alive, heartbeat 95s old)` | `2` | A live process holds the lock but its heartbeat is older than 30 s. |

```bash
ethos gateway status --json
```

```
{"state":"running","pid":4242,"heartbeatAgeMs":3811,"lockPath":"/home/me/.ethos/gateway.lock","spool":{"received":0,"processing":1,"done":57,"dead":0},"ledger":{"pending":0,"redelivering":0,"delivered":61,"abandoned":0}}
```

### ethos gateway spool {#ethos-gateway-spool}

Act on one dead-lettered inbound message in the [inbound spool](../../how-to/recover-messages-after-a-crash.md). `ethos doctor` lists dead rows with their ids.

| Subcommand | Args | Effect |
|---|---|---|
| `replay` | `<id>` | Dead → owed, attempts reset. A running gateway replays it within 60 s; otherwise its next start does. |
| `discard` | `<id>` | Dead → done, without a turn. |

Exits `0` on success, `1` when the id is unknown, the row is not dead, or no spool exists.

```bash
ethos gateway spool discard 6f1c2a3e-0b7d-4c55-9a51-1f0e8d2b7c44
```

```
Discarded 6f1c2a3e-0b7d-4c55-9a51-1f0e8d2b7c44.
```

## ethos listen {#ethos-listen}

Run a [wake satellite](../../../getting-started/glossary.md#wake-satellite) — a process that owns a microphone and streams captured speech to the web API's satellite lane at `GET /satellite/ws`. Long-running in the foreground.

Synopsis: `ethos listen [doctor] [--url <ws url>] [--route <id>] [--device <id>] [--play <command>] [--json]`

| Arg / flag | Type | Default | Description |
|---|---|---|---|
| `doctor` | subcommand | — | Preflight only: engine, model files, capture device, server reachability, player. Exits without starting anything. |
| `--url <ws url>` | string | derived from `webBaseUrl`, else `http://127.0.0.1:3000` | Satellite lane URL. A bare origin gets `/satellite/ws` appended; a URL with a path is taken as given. |
| `--route <id>` | string | unpinned — every enabled route may address this host | **Pins** the microphone to one route: only that phrase may address it, and another agent's phrase is discarded rather than answered. Resolved against the table the server pushes on connect — a `voice.wake.routes` id, or a synthesized `auto:<personality-id>` one. A pin that names no enabled route is a hard failure; the flag never exempts the host from needing a phrase. |
| `--device <id>` | string | the enumerated default | Capture device. This build enumerates `stdin` only. |
| `--play <command>` | string | the first of `ffplay`, `aplay`, `play` found on `PATH` | Command the reply's audio is written into, on that process's stdin. `{rate}` and `{channels}` are substituted, and the template runs through `sh -c`, so quoting and pipelines survive. Taken at face value — a supplied command is never second-guessed by a probe. With no flag and none of the three on `PATH`, the host registers `playback: false`, the server skips synthesis for it, and replies arrive as text. There is deliberately no config key: which command drives a sound card is a per-machine fact, like the capture pipe. |
| `--json` | flag | off | `doctor` only. One JSON object on stdout — probes, `configuredRoutes` and `requestedRoute` (never a resolved route: this command does not connect), node id, lane URL, and `exit` — then exits. |

Capture is a pipe — the daemon reads raw signed 16-bit little-endian **mono** PCM at **16 kHz** from stdin, and there is no microphone binding. Playout is a pipe for the same reason.

```bash
ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen   # macOS
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen                                          # Linux
```

The mic is **open** and the server decides who was addressed. Nothing here matches a phrase against sound: every captured utterance is transcribed server-side, and a turn runs only when the transcript opens with a wake phrase — which picks the personality and is stripped from the text — or follows one within [`voice.wake.idleTimeout`](../config-yaml.md#voice-wake). Anything else is transcribed and discarded. The room is therefore transcribed even when no agent answers. `--json` reports `engine.daemonMode: "open-mic"` and `engine.phraseMatch: false`, so a script cannot infer an acoustic gate from the engine name. Acoustic wake needs the `sherpa` engine and its models — see [`voice.wake.engine`](../config-yaml.md#voice-wake) and [Run a wake satellite](../../how-to/run-a-wake-satellite.md).

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Preflight clean. |
| `1` | Hard failure — this host will never hear you until it is fixed: no config, a bad `--url` or `--device`, a configured engine that will not load, or missing models for a `sherpa` host. |
| `2` | Warning — true right now and possibly not in a minute: nothing piped to stdin yet, or the server not answering yet. The daemon still refuses to start with no pipe, no usable engine, or a `--route` pin the server's table does not hold. An empty pushed table is a warning, not a refusal — a Settings save reaches the daemon without a restart. |

`ffplay` is probed first because it is the only one of the three that can open an encoded reply — `aplay` and `play` take raw samples only, and an opus or mp3 playout to either is refused rather than played as noise. Raw PCM plays at 24 kHz unless the lane declares a rate, which no first-party provider does today: `TtsProvider.synthesize` reports no sample rate. A reply that sounds fast or slow is that assumption, and `--play` with an explicit `-ar` is the override.

The microphone is suppressed for the whole reply, so the agent cannot wake itself. `playback_done` — the frame re-arming it — is sent when the player process **exits**, not when the words are known; a player that never exits trips a 90-second watchdog that re-arms anyway and says so.

State on disk: the node's stable id in `~/.ethos/listen-node-id`, and a heartbeat written every 10 seconds to `~/.ethos/listen-health.json` (the `gateway-health.json` shape plus `captureState`), removed on clean shutdown. `make listen` and `make listen-doctor` wrap both commands from a clone.

## ethos cron {#ethos-cron}

Schedule prompts to fire on cron expressions. `list` (default) shows every job with schedule, active hours, last run, next run. `create` schedules a new job (flags below). `update <id>` changes one. `pause <id>` / `resume <id>` / `delete <id>` manage existing jobs. `run <id>` fires immediately, even outside the job's active hours.

Synopsis: `ethos cron [list | create | update <id> | pause <id> | resume <id> | delete <id> | run <id>]`

Flags for `create`:

| Flag | Required | Description |
|---|---|---|
| `--name`, `-n <name>` | yes | Human-readable job name. |
| `--schedule`, `-s <expr>` | yes | 5-field cron expression (e.g. `0 8 * * *`). |
| `--prompt`, `-p <text>` | yes | Prompt the agent runs on each fire. |
| `--personality <id>` | no | Override the default personality for this job. |
| `--deliver <target>` | no | Delivery target (Telegram chat id, Slack channel, etc.). |
| `--active-hours <HH:MM-HH:MM>` | no | Daily window, on the host's clock, in which scheduled runs may happen. A start later than the end crosses midnight (`22:00-06:00`); start and end must differ. An occurrence outside it is skipped before any model call and is not counted as a run. Refused on a one-shot schedule. |

```bash
ethos cron create -n "Daily standup" -s "0 8 * * 1-5" -p "What's on my calendar today?"
ethos cron create -n "Check-in" -s "0 */3 * * *" -p "Check in." --active-hours 09:00-21:00
ethos cron update check-in --active-hours off
```

`update <id>` takes `--name`, `--schedule`, `--prompt`, `--script <file>`, `--precheck <file>` and `--active-hours <HH:MM-HH:MM|off>`; at least one is required. `off` clears the window. Walkthrough: [Schedule tasks with cron](../../how-to/schedule-tasks-with-cron.md#active-hours).

## ethos acp {#ethos-acp}

Run the Agent Control Protocol server. JSON-RPC over stdin/stdout. Long-running; typically spawned by an orchestrator.

Synopsis: `ethos acp`

## ethos serve {#ethos-serve}

Start the Ethos web UI and HTTP API on a local port. Long-running.

Synopsis: `ethos serve [--port <n>] [--bind <addr>] [--team <name>] [--mesh <name>]`

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `3000` | HTTP port. |
| `--bind <addr>` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose to LAN; still token-protected. |
| `--team <name>` | off | Resolve the agent against a [team](../../../getting-started/glossary.md#mesh) coordinator and mesh. |
| `--mesh <name>` | `default` | Explicit mesh name when `--team` is not set. |

Prints a sign-in URL of the form `http://localhost:3000/auth/exchange?t=<token>`. On an unclaimed instance, opening it sets the `ethos_auth` cookie and signs the browser in. On a claimed instance (username and password set at `/welcome`), the same URL opens `/welcome/reset` with the token prefilled instead of granting a session. With `ETHOS_WEB_TOKEN` set in the environment (at least 24 characters — a shorter value stops the boot), the URL is not printed at all.

## ethos status {#ethos-status}

Single-pane health summary — config, adapters, personalities, error log. Exits non-zero if critical issues are found.

Synopsis: `ethos status [--json]`

| Flag | Default | Description |
|---|---|---|
| `--json` | off | Machine-readable JSON output with version, config, adapter status, personality count, and error log summary. |

```bash
ethos status
ethos status --json
```

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
