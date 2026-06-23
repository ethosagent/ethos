#!/bin/bash
# scripts/ec2-bootstrap.sh — AWS EC2 user-data for Ethos.
#
# Paste the contents of this file into EC2's "User data" field at instance
# launch. It runs once on first boot as root (cloud-init handles that) and:
#
#   1. Installs Node 24, build tools, and @ethosagent/cli
#   2. Creates an `ethos` service user with state at /var/lib/ethos
#   3. Drops in a systemd unit running `ethos gateway start`
#
# The unit isn't enabled here — the operator runs `ethos setup` first to put
# tokens + API keys into ~/.ethos/config.yaml, then enables the service.
#
# Target OS:  Amazon Linux 2023 (canonical / recommended).
# Other OS:   Ubuntu 24.04 also works — swap `dnf` for `apt`, the NodeSource
#             setup script handles both. Any Linux that can run Node 24 is fine.
#
# Full guide: https://ethosagent.ai/docs/using/how-to/deploy-on-ec2

set -euo pipefail

# --- 1. Node 24 + build tools ------------------------------------------------
# Node 24 includes SQLite via node:sqlite — no native compilation needed.
# argon2 ships prebuilt binaries for common platforms; on a mismatch it
# compiles from source via node-gyp, which needs gcc + make + python3.
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs git
dnf groupinstall -y "Development Tools"
dnf install -y python3

# --- 2. Service user + state directory --------------------------------------
# State lives on a separate EBS volume mounted at /var/lib/ethos so AMI swaps
# or instance replacement don't lose sessions/memory. The symlink lets all of
# Ethos's `~/.ethos/`-relative paths resolve normally.
useradd -m -s /bin/bash ethos
mkdir -p /var/lib/ethos/logs
chown -R ethos:ethos /var/lib/ethos
ln -s /var/lib/ethos /home/ethos/.ethos
chown -h ethos:ethos /home/ethos/.ethos

# --- 3. Install @ethosagent/cli as the service user --------------------------
# User-local npm prefix keeps the global install out of /usr/lib and avoids
# needing root to upgrade later (`ethos upgrade` re-runs npm i -g as ethos).
sudo -u ethos bash -c '
  set -e
  npm config set prefix /home/ethos/.npm-global
  npm i -g @ethosagent/cli
  echo "export PATH=\$HOME/.npm-global/bin:\$PATH" >> /home/ethos/.bashrc
'

# --- 4. systemd unit ---------------------------------------------------------
# Gateway-only by default — zero inbound, no dashboard, the simple case.
# To also run the web dashboard + ACP, change `ethos gateway start` below to
# `ethos run-all`, reach the dashboard via SSH tunnel:
#     ssh -L 3000:localhost:3000 ec2-user@<box>
# or SSM port forwarding:
#     aws ssm start-session --target <instance-id> \
#       --document-name AWS-StartPortForwardingSession \
#       --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'
cat > /etc/systemd/system/ethos.service <<'UNIT'
[Unit]
Description=Ethos agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ethos
Environment=HOME=/home/ethos
Environment=PATH=/home/ethos/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/ethos/.npm-global/bin/ethos gateway start
Restart=on-failure
RestartSec=5
# Logs go to journald (journalctl -u ethos -f) AND to ~/.ethos/logs/.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload

echo "ethos: bootstrap complete."
echo "Next: connect to the instance and run"
echo "      sudo -iu ethos && ethos setup"
echo "Then: sudo systemctl enable --now ethos"
