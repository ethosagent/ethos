---
title: "Deploy Ethos on AWS EC2"
description: "One EC2 instance, one EBS volume, one systemd unit. The simplest production deployment of Ethos on AWS — no load balancer, no Route 53, no certificate."
kind: how-to
audience: user
slug: deploy-on-ec2
time: "15 min"
updated: 2026-11-03
---

## Task

Run Ethos as a single always-on EC2 instance with persistent state, surviving reboots and instance replacement. Architecture is deliberately small: **one EC2 + one EBS volume + one systemd unit**. No load balancer, no public DNS, no certificate.

## Result

- Telegram + Slack + Discord + Email bots online 24/7.
- State (sessions, memory, config) on a separate EBS volume — AMI swaps don't lose data.
- AWS Backup takes daily snapshots; recover by re-attaching the volume.
- ~$13/month for `t4g.small` + 10 GB `gp3` + outbound LLM-API traffic.

For the architecture explainer (why these processes, why this shape), see [Deploy in production](deploy-in-production.md). This page is the AWS-specific recipe.

## Prereqs

- AWS account; permission to launch EC2 instances + create EBS volumes + create IAM roles.
- One LLM provider API key, and at least one channel token (Telegram from BotFather, Slack bot token, etc.).
- Decide how you'll connect:
  - **SSM Session Manager (recommended)** — no SSH key, no port 22, no public IP needed. Requires an IAM role on the instance with the `AmazonSSMManagedInstanceCore` managed policy, and `session-manager-plugin` installed on your laptop ([AWS install instructions](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)).
  - **SSH** — works fine. Generate an EC2 key pair, open port 22 to your IP, the rest is the same.

**OS choice** is a recommendation, not a requirement. The canonical script targets **Amazon Linux 2023** (default AWS AMI, dnf-based, SSM agent preinstalled). Ubuntu 24.04 also works — the script's package commands are the only thing you'd swap. Any Linux that can run Node 24 fits.

## Parts

| Part | Covers |
|---|---|
| This page | Launch the instance, bootstrap script, mount the EBS state volume, security posture |
| [Service, backup and operation](deploy-on-ec2/service-and-operate.md) | `ethos setup`, systemd service, AWS Backup, optional web dashboard, day-to-day commands |

## Steps

### 1. Launch the instance

In the EC2 console → **Launch instance** → fill in:

| Field | Value | Why |
|---|---|---|
| **Name** | `ethos` | identification |
| **AMI** | Amazon Linux 2023 (default) | matches the bootstrap script |
| **Instance type** | `t4g.small` (~$12/mo) | ARM, plenty for 1–2 bots; bump to `t4g.medium` for many personalities |
| **Key pair** | leave blank (SSM) or pick one (SSH) | your choice per Prereqs |
| **Network** | default VPC, any subnet, auto-assign public IPv4 ON | gateway dials out; public IP is only needed for outbound (no inbound rules) |
| **Security group** | new SG, **inbound: none** (SSM) or **SSH from your IP** | zero inbound is the goal — gateway is dial-out only |
| **Storage** | root: 8 GB gp3 (default); **add second volume**: 10 GB gp3, mount `/dev/sdf`, **Encrypted: yes** | state on its own encrypted volume — see [Security](#security) |
| **Advanced → IAM instance profile** | role with `AmazonSSMManagedInstanceCore` (SSM only) | enables SSM Session Manager; skip if using SSH |
| **Advanced → Metadata version** | V2 only (required) | IMDSv2 — see [Security](#security) |
| **Advanced → User data** | paste the [bootstrap script](#the-bootstrap-script) | runs once on first boot |

Launch it. The bootstrap takes ~3 minutes; watch progress with **EC2 → Instance → Actions → Monitor and troubleshoot → Get system log**.

### 2. The bootstrap script {#the-bootstrap-script}

The canonical script lives at [scripts/ec2-bootstrap.sh](https://github.com/ethosagent/ethos/blob/main/scripts/ec2-bootstrap.sh) in the repo. Paste its contents into the **User data** field at launch — or fetch it locally first if you want to review or modify:

```bash
curl -O https://ethosagent.ai/ec2-bootstrap.sh
# review, then paste into User data
```

It installs Node 24, creates the `ethos` service user, mounts state at `/var/lib/ethos`, installs `@ethosagent/cli`, and drops in a systemd unit. The unit is **not enabled yet** — you run `ethos setup` first, then enable.

### 3. Mount the EBS state volume

Once the instance is up, attach the 10 GB volume you created to `/var/lib/ethos`. The user-data script created that path empty; you mount the EBS device on top:

```bash
# inside the instance (SSM Session Manager or ssh)
sudo mkfs -t xfs /dev/nvme1n1    # one-time format; nvme1n1 is the second volume
sudo mount /dev/nvme1n1 /var/lib/ethos
sudo chown -R ethos:ethos /var/lib/ethos

# persist across reboots
echo "/dev/nvme1n1 /var/lib/ethos xfs defaults,nofail 0 2" | sudo tee -a /etc/fstab
```

(The device name may be `xvdf` on older instance types; `lsblk` tells you what's actually there.)

## Next

Continue with [Service, backup and operation](deploy-on-ec2/service-and-operate.md) for steps 4 to 6: `ethos setup`, enabling the systemd service and AWS Backup.

## Verify

After step 3, `df -h /var/lib/ethos` shows the EBS device, not the root volume, and `ls -ld /var/lib/ethos` shows it owned by `ethos`. The full deployment check is in part 2.

## Security

A short list of zero- and low-cost wins, all baked into the steps above:

- **Encrypted EBS state volume.** Step 1 sets `Encrypted: yes` on the 10 GB state volume. Everything sensitive — `~/.ethos/config.yaml` (provider keys, bot tokens), `sessions.db` (every conversation), `memory/` files — lives on this volume and is encrypted at rest. AWS Backup snapshots inherit the encryption.
- **IMDSv2 required.** Step 1 sets `Metadata version: V2 only`. Stops a class of SSRF-into-AWS-credentials exploits where a misbehaving tool fetches `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — V2 requires a session token most exploit paths can't forge.
- **Zero inbound traffic** by default. The gateway is dial-out (Telegram long-polls, Slack uses Socket Mode). The security group has no inbound rules unless you choose SSH. SSM Session Manager doesn't open a port at all.
- **Least-privilege IAM role.** The instance role only needs `AmazonSSMManagedInstanceCore` for Session Manager. Don't attach an admin role; you don't need one.
- **`ethos` service user, not root.** The systemd unit runs as `User=ethos`. Even if a tool the agent runs escapes its boundary, it doesn't escape to root.

What this deployment shape deliberately *doesn't* solve, and what to add if you need them:

- **Secrets at rest while the instance is running** — encrypted volume protects against snapshot theft, not a logged-in root user. See [Configure AWS Secrets Manager](configure-aws-secrets.md) to fetch tokens from AWS at runtime instead of storing them on the EBS volume.
- **Public dashboard with auth** — out of scope. The tunnel approach above is the right answer until you have a reason to expose the dashboard, at which point you want a reverse proxy + a real auth story, not just port-opening.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Bootstrap script failed with `gyp ERR! build error` | A native dependency failed to compile | Install build tools: `dnf groupinstall "Development Tools"` (AL2023) or `sudo apt-get install build-essential` (Debian/Ubuntu), then re-run `pnpm install` |
| SSM session won't start | Missing IAM role / SSM agent not running | Confirm `AmazonSSMManagedInstanceCore` is attached; on AL2023 SSM is preinstalled. On Ubuntu, `sudo snap install amazon-ssm-agent --classic`. |
| State lost after instance replacement | EBS volume wasn't separate / wasn't attached to the new instance | Step 1's "second volume mounted at `/var/lib/ethos`" is the load-bearing call. AWS Backup snapshots are the recovery path. |

For everything else: `journalctl -u ethos -n 200`, `ethos doctor`, [Troubleshooting reference](../../troubleshooting.md).
