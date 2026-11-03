---
title: "Deploy Ethos in production: PM2, operation and alternatives"
description: "Hand ethos run-all to PM2 for reboot survival, operate it day to day, and pick systemd or launchd instead."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Hand `ethos run-all` to PM2 so the gateway and web dashboard survive reboots, then operate the box day to day.

## Result

`pm2 status` shows `ethos` online, it starts again after `sudo reboot`, and you know where the logs are and how to restart and upgrade it.

## Prereqs

- Complete [Deploy Ethos in production](../deploy-in-production.md) through step 3: Ethos and PM2 installed, `ethos setup` done, and `ethos run-all` works in the foreground.
- Shell access to the box; `sudo` for `pm2 startup`.

## Steps

### 4. Hand it to PM2 for reboot survival

Download the reference PM2 config and start:

```bash
curl -O https://ethosagent.ai/ecosystem.config.js
pm2 start ecosystem.config.js
pm2 save
pm2 startup       # follow the printed command — it auto-starts at boot
```

`pm2 status` should show one `ethos` process running. Reboot the box; it comes back up on its own.

If you don't want to use the hosted config, this is the whole file:

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'ethos',
      script: 'ethos',
      args: 'run-all',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2_000,
      // PM2 SIGKILLs 1.6s after SIGTERM by default, which cuts the children's
      // drain short. Must exceed run-all's 30s grace (SHUTDOWN_GRACE_MS).
      kill_timeout: 35_000,
      out_file: '~/.pm2/logs/ethos-out.log',
      error_file: '~/.pm2/logs/ethos-err.log',
      time: true,
    },
  ],
};
```

### 5. Operate it from your laptop

The box is now running bots forever. To chat with the agent directly:

- **Same machine?** Open another terminal: `ethos chat`. The CLI shares `~/.ethos/` with the running daemons via SQLite (WAL mode handles concurrent reads); your chat session is on its own lane (`cli:<cwd>`) and doesn't collide with bot sessions.
- **Remote box?** SSH in and run `ethos chat`. Or run `ethos chat` on your laptop with its own `~/.ethos/` — completely independent. Bots on the server, REPL on your laptop, two different states.

The mental separation: **bots run where they need to run; chat happens where you are**.

## Verify

- `pm2 status` shows `ethos` as `online`.
- `pm2 logs ethos` streams supervisor output (the `✓ gateway · ✓ serve` lines).
- `tail -f ~/.ethos/logs/gateway.log` shows per-child output.
- `curl -s http://localhost:3000/api/health` (or whatever your health route is) returns 200.
- Telegram / Slack: send a message; the bot replies; the message appears in the dashboard's Sessions tab at `:3000`.
- Reboot the box: `sudo reboot`. Wait. SSH back in: `pm2 status` shows `ethos` online again, no manual start needed.

## Operate

### Logs

| What | Where | How |
|---|---|---|
| Supervisor (`ethos run-all`) output | `~/.pm2/logs/ethos-out.log` | `pm2 logs ethos` |
| Gateway child | `~/.ethos/logs/gateway.log` | `tail -f ~/.ethos/logs/gateway.log` |
| Serve child | `~/.ethos/logs/serve.log` | `tail -f ~/.ethos/logs/serve.log` |
| Crash reports | `~/.ethos/errors/` | `ethos errors` |

### Restart, stop, status

```bash
pm2 restart ethos    # restart both children (supervisor + everything under it)
pm2 stop ethos       # stop, keep the registration (for later `pm2 start`)
pm2 delete ethos     # remove from PM2 entirely
pm2 status           # one-line status of every PM2 process on the box
pm2 monit            # full-screen monitor with CPU + memory + log tail
```

### Upgrade

```bash
ethos upgrade        # in-place upgrade of @ethosagent/cli
pm2 restart ethos    # pick up the new binary
```

`pm2 startup` already wires reboot survival, so an upgrade-then-restart cycle is the full update flow.

### Adjust resources

Ethos's footprint is light — typical single-operator deployment on a 4 GB Pi:

- Idle: ~150 MB RAM (supervisor + 2 children). Measure your own: `ethos status` prints the running gateway's resident set size from its heartbeat, and the gateway's `:3002/metrics` exports `ethos_process_rss_bytes` and `ethos_process_heap_used_bytes`.
- Active turn: spikes by ~200–400 MB depending on the model and context size.
- Disk: SQLite under `~/.ethos/` grows ~1 MB per hundred messages. Run `ethos retention` to set caps.
- Network: outbound only by default. Telegram long-polling and Slack Socket Mode dial out; you don't need an inbound port unless you publish the web dashboard.

If you want the dashboard reachable from the open internet, put a reverse proxy (Caddy is two lines of config) in front of `:3000` — and absolutely require auth on the web side (`ethos api-key create` for bearer-token access).

## Alternatives to PM2

PM2 is the easiest cross-platform path; here's the rest of the table:

- **Linux server** — systemd user unit running `ethos run-all`. Generate the unit file with `ethos systemd-unit ethos-runall > ~/.config/systemd/user/ethos-runall.service`, then `systemctl --user enable --now ethos-runall`. See [Run as a daemon](../run-as-daemon.md) for the full walkthrough and [CLI reference](../../reference/cli.md#ethos-systemd-unit) for all available units.
- **macOS** — launchd plist running `ethos run-all`. Also in [Run as a daemon](../run-as-daemon.md).
- **Docker** — official image is planned; not yet shipped. Build your own from `node:24-alpine` + `npm i -g @ethosagent/cli`; mount `~/.ethos/` as a volume.
- **Manual `tmux` / `screen`** — for development or "I'll just leave it running while I'm logged in." Not for production; survives logout only with `screen -d -m` discipline.

Whichever you pick, the inside is the same: one `ethos run-all` process, two children, shared `~/.ethos/`.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Bots stop responding but `pm2 status` shows `online` | Inside-process hang (rare); supervisor doesn't see it | `pm2 restart ethos`; if it repeats, check provider rate-limits or network egress |
| Two `ethos chat` sessions see each other's history | They're using the same session key (`cli:<cwd-basename>`) | `cd` to a different directory, or run `ethos chat` with `/new` to start a fresh session |
| `pm2 startup` printed a `sudo` command but it didn't run | Boot-time wiring needs root | Run the exact `sudo env PATH=...` line PM2 printed — that's the bit that survives reboot |
| After `ethos upgrade`, bots use the old version | PM2 still has the old child cached | `pm2 restart ethos` |

For everything else: `pm2 logs ethos --lines 200`, `ethos doctor`, [Troubleshooting reference](../../../troubleshooting.md).

## What you learned

- The four moving parts: `ethos run-all` (supervisor) → `gateway start` + `serve` (children) → `~/.ethos/` (shared state) → `ethos chat` (operator REPL).
- One command starts everything (`ethos run-all`); PM2 keeps it alive across reboots.
- Failure isolation works because children are real subprocesses, not in-process threads.
- The mini-PC sizing reality: 4 GB RAM is plenty, outbound network is enough.

## Next step

- [Run multiple Telegram bots from one gateway](../run-multi-bot-telegram.md) — one Ethos instance, several personalities each with their own bot.
- [Run a team with kanban](../run-a-team-with-kanban.md) — multi-personality teams that coordinate through a shared board.
- [Connect Telegram to a team](../connect-telegram-to-team.md) — wire the team coordinator to a Telegram bot.
