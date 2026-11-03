---
title: "Deploy Ethos in production"
description: "Run the gateway (bots) and web dashboard together on a mini PC, VPS, or home server. One supervised command; PM2 keeps it alive across reboots."
kind: how-to
audience: user
slug: deploy-in-production
time: "10 min"
updated: 2026-11-03
---

## Task

Run Ethos on an always-on machine — a mini PC, a Raspberry Pi 4+, a cheap VPS, a home server — so your Telegram and Slack bots stay online, the web dashboard is reachable, and the whole thing survives a power cut or a reboot. Operate it from your laptop via `ethos chat` when you want to drive it directly.

## Result

- Telegram + Slack + Discord + Email bots running under one supervisor.
- Web dashboard reachable at `http://<your-box>:3000`.
- ACP server reachable at `http://<your-box>:3001` for editor integrations.
- A crash in one surface doesn't take the others down; supervisor restarts the failed child automatically.
- Everything comes back after a reboot — no manual intervention.

## Prereqs

- A machine you can keep on: mini PC (Beelink, Mac mini, NUC), Raspberry Pi 4 with 4 GB+ RAM, a Linux VPS (Hetzner, Fly, DigitalOcean, etc.), or a Mac you don't shut down.
- Node 24+ installed (`node --version`).
- API keys for at least one [LLM provider](configure-providers.md) and one [channel](../../platforms/telegram.md) you want to expose.
- Network access from the box outbound (LLM APIs, Telegram, Slack).
- `ffmpeg` on `PATH`, if you want spoken replies on channels. Optional — the gateway runs and speaks without it, but only in formats the TTS provider already emits, and it prints a `⚠ ffmpeg not found` notice at startup. Install with `sudo apt-get install -y ffmpeg` (Debian/Ubuntu), `sudo dnf install -y ffmpeg` (AL2023/Fedora), or `brew install ffmpeg`. See [Send and receive voice notes on a channel](voice-notes-on-channels.md).

The official mental model: you don't need a beefy server. A 4 GB Pi or a $5 VPS is plenty for a single operator's bots; SQLite WAL handles concurrent reads, the long-polling/Socket-Mode adapters dial out so you don't even need an inbound port unless you want the web dashboard public.

## Parts

| Part | Covers |
|---|---|
| This page | Install, first-run setup, foreground test of `ethos run-all` |
| [PM2, operation and alternatives](deploy-in-production/pm2-and-operate.md) | PM2 config and reboot survival, chatting from your laptop, logs, upgrade, resources, systemd and launchd alternatives |

## The shape of a production deployment

Ethos is not one process running everything — it's a few small processes that share `~/.ethos/`. The two long-running ones for production are:

- **`ethos gateway start`** — every channel adapter (Telegram, Slack, Discord, Email).
- **`ethos serve`** — web dashboard (`:3000`) and ACP server (`:3001`).

`ethos run-all` is the supervisor that brings both up with one command. It spawns them as child processes, watches them, and restarts the one that crashed (with exponential backoff). PM2 (or systemd, or launchd) wraps `ethos run-all` so it survives reboots.

<figure class="ethos-figure"><div class="ethos-figure-pad"><svg viewBox="0 0 620 512" role="img" aria-label="Diagram of the production deployment shape. On your mini PC, VPS, or home server, PM2 runs ethos run-all as the supervisor, which spawns two children: ethos gateway start (child 1) running the Telegram bot, Slack bot, Discord bot, and Email, and ethos serve (child 2) running the web dashboard on port 3000 and the ACP server on port 3001. Both share state in ~/.ethos/ and write child logs to ~/.ethos/logs/gateway.log and serve.log. Below, your laptop (the operator) runs ethos chat — a REPL whenever you want to drive the agent, while the bots keep running whether your laptop is on or not — connected to the same ~/.ethos/ via SSH, or a different one on your laptop." font-family="Geist Mono,monospace">
<defs><marker id="prod-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#70706B"/></marker></defs>
<rect x="10" y="10" width="600" height="298" rx="10" fill="#9CC5F2" fill-opacity="0.07" stroke="#9CC5F2"/>
<rect x="150" y="50" width="320" height="38" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<path d="M310 88 V104 H170 V118" fill="none" stroke="#70706B" marker-end="url(#prod-arrow)"/>
<path d="M310 88 V104 H460 V118" fill="none" stroke="#70706B" marker-end="url(#prod-arrow)"/>
<rect x="40" y="122" width="260" height="124" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<rect x="330" y="122" width="260" height="96" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<rect x="110" y="404" width="400" height="96" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<line x1="240" y1="404" x2="240" y2="312" stroke="#70706B" marker-end="url(#prod-arrow)"/>
<g font-size="13" fill="var(--ethos-text-primary)">
<text x="30" y="36">Your mini PC / VPS / home server</text>
<text x="310" y="74" text-anchor="middle">PM2 → ethos run-all (supervisor)</text>
<text x="56" y="146">ethos gateway start</text>
<text x="346" y="146">ethos serve</text>
<text x="126" y="428">Your laptop (operator)</text>
<text x="126" y="452">ethos chat</text>
</g>
<g font-size="11" fill="var(--ethos-text-secondary)">
<text x="284" y="146" text-anchor="end">[child 1]</text>
<text x="574" y="146" text-anchor="end">[child 2]</text>
<text x="56" y="170">Telegram bot</text>
<text x="56" y="188">Slack bot</text>
<text x="56" y="206">Discord bot</text>
<text x="56" y="224">Email</text>
<text x="346" y="170">web dashboard  :3000</text>
<text x="346" y="188">ACP server     :3001</text>
<text x="40" y="270">Shared state:  ~/.ethos/</text>
<text x="40" y="288">Child logs:    ~/.ethos/logs/{gateway,serve}.log</text>
<text x="252" y="352">same ~/.ethos/ via SSH</text>
<text x="252" y="368">(or a different one on your laptop)</text>
<text x="126" y="472">REPL whenever you want to drive the agent</text>
<text x="126" y="488">bots keep running whether your laptop is on or not</text>
</g>
</svg></div><figcaption>PM2 supervises ethos run-all, which spawns the gateway and serve children on the always-on box; your laptop drives the same agent over SSH with ethos chat.</figcaption></figure>

## Steps

### 1. Install Ethos and PM2 on the box

SSH to your mini-PC / server, install Node 24 if needed, then:

```bash
npm i -g @ethosagent/cli pm2
ethos --version    # confirm it's installed
pm2 --version      # PM2 is the process manager that keeps ethos alive
```

### 2. First-run setup

```bash
ethos setup
```

The wizard configures your default provider, adds an API key, picks a personality, and walks you through Telegram / Slack / Discord / Email tokens for whichever channels you want online. Everything lands in `~/.ethos/config.yaml`.

### 3. Verify with a foreground run before daemonising

Always foreground-test once before handing it to PM2. If anything is misconfigured (bad token, missing model, port collision), you want the error in your terminal, not buried in a log.

```bash
ethos run-all
```

You should see one line per child:

```
ethos run-all — 2 children
✓ gateway  pid 12345 · logs: ~/.ethos/logs/gateway.log
✓ serve    pid 12346 · logs: ~/.ethos/logs/serve.log
```

Test it:

- Send a DM to your Telegram bot → it replies.
- Send a `@mention` in your Slack workspace → it replies.
- Open `http://<box-hostname>:3000/` → the dashboard loads.

Stop with **Ctrl-C**. Both children receive `SIGTERM`, finish what is in flight, close their databases and exit — usually in well under a second on an idle box. A child that is mid-turn or draining a background job gets up to 30 seconds before the supervisor escalates to `SIGKILL` (`SHUTDOWN_GRACE_MS` in `apps/ethos/src/commands/run-all.ts`, pinned by `apps/ethos/src/commands/__tests__/run-all.test.ts`). Whatever supervises `ethos run-all` must allow at least that long — see the `kill_timeout` in the PM2 config below.

## Next

Continue with [PM2, operation and alternatives](deploy-in-production/pm2-and-operate.md) to survive reboots (step 4) and operate the box (step 5).

## Verify

After step 3, `ethos run-all` prints one `✓` line per child, the Telegram bot replies to a DM, and `http://<box-hostname>:3000/` loads the dashboard. Reboot survival is verified in part 2.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `ethos run-all` exits immediately with "Run ethos setup first" | `~/.ethos/config.yaml` missing | Run `ethos setup` |
| `gateway` keeps crashing in restart loop | Bad Telegram / Slack token, or no provider configured | `tail -f ~/.ethos/logs/gateway.log` — the error is usually one line; fix the token in `~/.ethos/config.yaml` |
| Supervisor gives up after 10 crashes in 5 minutes | Real crash loop, intentional safety net | Inspect the child log; the supervisor sets `exitCode = 1` so PM2 restarts the whole thing. Fix the cause first. |
| Web dashboard isn't reachable | `:3000` not bound to `0.0.0.0`, or firewall blocking | Bind options in [serve](../reference/cli.md#ethos-serve); open the port in your firewall |

For everything else: `ethos doctor`, [Troubleshooting reference](../../troubleshooting.md).
