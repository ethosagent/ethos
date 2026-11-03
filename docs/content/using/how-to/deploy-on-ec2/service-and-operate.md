---
title: "Deploy Ethos on AWS EC2: service, backup and operation"
description: "Run ethos setup, enable the systemd service, schedule AWS Backup and operate the instance, including the optional web dashboard."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Configure Ethos on the running EC2 instance, enable it as a systemd service, and back up the state volume.

## Result

The gateway restarts on boot under systemd as the `ethos` user, AWS Backup snapshots the state volume daily, and you know the commands to operate it.

## Prereqs

- Complete [Deploy Ethos on AWS EC2](../deploy-on-ec2.md) through step 3: instance launched, bootstrap script run, EBS volume mounted at `/var/lib/ethos`.
- A shell on the instance (SSM Session Manager or SSH).

## Steps

### 4. Connect and run `ethos setup`

**With SSM Session Manager:**

```bash
aws ssm start-session --target i-0123456789abcdef0
```

**With SSH:**

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<public-ip-or-dns>
```

Either way, become the `ethos` user and run setup:

```bash
sudo -iu ethos
ethos setup
```

The wizard asks for your LLM provider + key, picks a default personality, and walks through Telegram / Slack / Discord / Email tokens for whichever channels you want. Everything lands in `~/.ethos/config.yaml` — which actually lives on the encrypted EBS state volume.

Foreground-test before enabling the service:

```bash
ethos gateway start
# DM your bot, confirm a reply, Ctrl+C
exit       # back to your shell user
```

### 5. Enable the service

```bash
sudo systemctl enable --now ethos
sudo systemctl status ethos
```

`enable --now` starts the service and wires it to launch at boot. The service runs `ethos gateway start` as the `ethos` user.

Verify:

- Send a DM to your bot — it replies.
- `journalctl -u ethos -f` — streams the gateway's logs.
- Reboot the instance (`sudo reboot`). Reconnect. `systemctl status ethos` shows `active (running)` — no manual intervention needed.

### 6. Set up AWS Backup for the state volume

Daily EBS snapshots cover the "I accidentally `rm -rf ~/.ethos`" and "the instance was terminated" cases.

In the AWS Backup console:

1. **Backup plans → Create backup plan → Start with a template → Daily backups**.
2. **Resource assignments → Resources** → tag-based selection (tag the EBS volume with `backup: daily`).
3. Retention: 7 days is plenty for state recovery; bump to 30 if your compliance posture wants it.

That's it. AWS Backup takes encrypted snapshots inheriting the volume's encryption.

## Verify

Confirm the deployment is healthy after the steps above:

- **Bot replies.** DM your Telegram bot (or `@mention` in Slack). Reply lands within a few seconds.
- **Service active + enabled.** `sudo systemctl status ethos` shows `active (running)` and `enabled` (will start on boot).
- **Logs stream.** `journalctl -u ethos -f` shows the gateway's startup banner and per-turn output.
- **State volume mounted.** `df -h /var/lib/ethos` shows the EBS device (not the root volume). `ls -la /home/ethos/.ethos` shows the symlink target.
- **Reboot survival.** `sudo reboot`, reconnect (SSM or SSH), `systemctl status ethos` shows `active (running)` again with no manual intervention.
- **Backup ran.** AWS Backup console → Jobs tab → daily snapshot of the state volume appears within 24h of plan creation.

If any of these fail, jump to [Troubleshoot](#troubleshoot) below.

## Run the web dashboard too (optional)

The default deployment is **gateway-only** — no inbound port, no dashboard, the simplest case. To also run the web dashboard + ACP server, swap the systemd unit's `ExecStart`:

```bash
sudo sed -i 's|ethos gateway start|ethos run-all|' /etc/systemd/system/ethos.service
sudo systemctl daemon-reload
sudo systemctl restart ethos
```

Now `ethos run-all` is supervising both `gateway start` and `serve`. The dashboard binds to `localhost:3000` on the instance. Reach it from your laptop without ever opening the port to the internet:

**Via SSH tunnel:**

```bash
ssh -L 3000:localhost:3000 ec2-user@<public-ip>
# now browse http://localhost:3000 on your laptop
```

**Via SSM port forwarding** (no SSH key needed):

```bash
aws ssm start-session --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'
# browse http://localhost:3000 on your laptop
```

Same security posture either way — the dashboard is never reachable from the public internet, only through your authenticated tunnel.

## Operate

| What | Command |
|---|---|
| Stream gateway logs | `journalctl -u ethos -f` |
| Restart the service | `sudo systemctl restart ethos` |
| Stop / start | `sudo systemctl stop ethos` / `sudo systemctl start ethos` |
| Status + last 10 log lines | `sudo systemctl status ethos` |
| Upgrade | `sudo -iu ethos ethos upgrade && sudo systemctl restart ethos` |
| Talk to the agent from your laptop | SSM/SSH in, run `ethos chat` (uses its own session lane, doesn't collide with the bots) |

State volume layout reminder:

```
/var/lib/ethos/                ← EBS volume mount, owned by ethos
├── config.yaml                ← tokens + provider keys
├── personalities/<id>/        ← personality definitions + per-personality memory
├── sessions.db                ← every conversation ever
├── logs/{gateway,serve}.log   ← per-child logs (if using run-all)
└── ...
```

Operator's laptop story: `ethos chat` on your laptop uses its own `~/.ethos/` (totally separate state), and the bots running on the EC2 box keep going whether your laptop is open or not. To chat with the *same* agent state the bots use, SSM/SSH in and run `ethos chat` on the instance.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `ethos: command not found` after `sudo -iu ethos` | PATH not picked up from `.bashrc` | Run `source ~/.bashrc` once, or use the absolute path: `/home/ethos/.npm-global/bin/ethos setup` |
| `systemctl status ethos` shows `failed` with `Run ethos setup first` | The unit started before tokens were configured | `sudo -iu ethos && ethos setup`, then `sudo systemctl restart ethos` |
| Telegram bot stops responding but `systemctl status ethos` shows `active` | Token revoked, or Telegram API blocked | `journalctl -u ethos -n 100` — the error is usually one line. Fix the token in `~/.ethos/config.yaml`, restart. |
| `ethos upgrade` says "command not found: npm" | Bare `sudo -u ethos ethos upgrade` (without `-i`); login shell wasn't sourced | Always use `sudo -iu ethos ethos upgrade` — the `-i` is what loads PATH and HOME correctly |

For everything else: `journalctl -u ethos -n 200`, `ethos doctor`, [Troubleshooting reference](../../../troubleshooting.md).

## What you learned

- One EC2 + one EBS + one systemd unit is the whole AWS architecture for a single-operator Ethos deployment.
- The bootstrap script automates the fragile bits (Node version, build tools, service user, systemd wiring).
- State on a separate encrypted EBS volume + AWS Backup snapshots = upgrade-safe and recoverable.
- Web dashboard runs the same way — flip the systemd unit to `ethos run-all`, reach it via SSH tunnel or SSM port forwarding.

## Next step

- [Deploy in production](../deploy-in-production.md) — the platform-neutral architecture for context.
- [Run multiple Telegram bots from one gateway](../run-multi-bot-telegram.md) — one EC2 instance, several personalities, several bots.
- [Run a team with kanban](../run-a-team-with-kanban.md) — multi-personality teams that coordinate on this same box.
