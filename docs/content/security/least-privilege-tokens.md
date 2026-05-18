---
title: Least-privilege token cookbook
description: Per-provider instructions for minting minimally scoped tokens for Slack, Telegram, Discord, GitHub, Linear, and Notion integrations.
kind: how-to
audience: shared
slug: least-privilege-tokens
time: "15 min"
updated: 2026-05-18
---

## Task

Create tokens for each channel and integration provider that give an Ethos agent the minimum access it needs -- nothing more. This page walks through each provider in turn, lists the exact scopes or permissions, and explains the mitigations for providers that lack fine-grained scoping.

## Result

Every integration token your agent uses is scoped to the narrowest possible permission set. Write access is added only where the agent's personality explicitly requires it. Audit trails in `observability.db` can trace every action back to a known, minimal capability.

## Prereqs

- Admin or owner access to each provider's developer portal (Slack API dashboard, Telegram BotFather, Discord Developer Portal, GitHub Settings, Linear workspace, Notion integrations page).
- A running Ethos instance with `~/.ethos/config.yaml` configured for the target channels.
- Familiarity with the [security controls](./controls.md) that Ethos enforces at the channel layer.

## Steps

### 1. Slack

Slack uses OAuth scopes on two token types: a **Bot Token** (starts with `xoxb-`) and an **App-Level Token** (starts with `xapp-`).

#### Bot token scopes

Request only the scopes the agent needs. Start with this baseline and add scopes one at a time:

| Scope | Purpose | Required? |
|---|---|---|
| `channels:read` | List public channels the bot is in | Yes |
| `channels:history` | Read messages in public channels | Yes |
| `chat:write` | Send messages | Yes |
| `users:read` | Resolve user display names | Yes |
| `reactions:write` | Add emoji reactions (acknowledgements, status) | Recommended |
| `app_mentions:read` | Receive `app_mention` events (mention-gated bots) | If using mention gate |

Do **not** add `channels:manage`, `admin.*`, `files:write`, or any scope prefixed with `groups:` unless the personality's toolset explicitly requires private-channel or admin operations.

#### App-level token (Socket Mode)

1. Go to **https://api.slack.com/apps/{YOUR_APP_ID}/general**.
2. Enable **Socket Mode**.
3. Generate an App-Level Token with the single scope `connections:write`.

Socket Mode avoids exposing a public HTTP endpoint, but it does not replace the signing secret. Always configure the signing secret in `~/.ethos/config.yaml` even when using Socket Mode -- Ethos validates it on every inbound event regardless of transport.

#### Verify

```bash
# List the scopes on your bot token (requires curl + jq)
curl -s -H "Authorization: Bearer xoxb-YOUR-TOKEN" \
  https://slack.com/api/auth.test | jq '.response_metadata.scopes'
```

Confirm the returned list matches the table above and nothing more.

### 2. Telegram

Telegram bot tokens are all-or-nothing. BotFather issues a single token with full bot permissions -- there is no scope system.

#### Create the token

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot` and follow the prompts.
3. Copy the token BotFather returns.

#### Mitigations

Since Telegram offers no per-scope restriction, apply these compensating controls:

1. **Sender allowlist.** Configure `channel_filter` in `config.yaml` to restrict which Telegram user IDs or chat IDs the agent responds to. Ethos drops messages from unlisted senders at the channel layer before they reach the agent loop.
2. **Disable group joins.** Send `/setjoingroups` to BotFather and select **Disable**. This prevents anyone from adding the bot to arbitrary groups.
3. **Disable inline mode.** Send `/setinline` to BotFather and leave inline mode off unless the personality requires it.

#### Verify

Send a message from a non-allowlisted account. Confirm the agent does not respond and that `observability.db` logs a `channel.deny` event.

### 3. Discord

Discord uses a permissions integer -- a single number encoding a bitfield of allowed actions.

#### Minimum permissions

| Permission | Bit | Hex | Purpose |
|---|---|---|---|
| `VIEW_CHANNEL` | 10 | `0x400` | See channels the bot is added to |
| `SEND_MESSAGES` | 11 | `0x800` | Post messages |
| `READ_MESSAGE_HISTORY` | 16 | `0x10000` | Read past messages for context |
| `MESSAGE_CONTENT` | 15 | `0x8000` | Access message text (privileged intent) |

#### Calculate the permissions integer

OR the hex values together:

```
0x400 | 0x800 | 0x10000 | 0x8000 = 0x19C00
```

In decimal: **104448**. Use this value when generating the OAuth2 invite URL:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=104448
```

Do **not** use `8` (Administrator) or `70368744177655` (all permissions). These are the Discord equivalent of `root`.

#### Privileged intents

`MESSAGE_CONTENT` is a privileged intent. Discord requires explicit approval in the Developer Portal for bots in 100 or more servers. Enable it under **Bot > Privileged Gateway Intents** before scaling. For bots under 100 servers, toggle it on in the portal -- no approval form needed.

#### Verify

1. Open the Discord Developer Portal at **https://discord.com/developers/applications/{APP_ID}/bot**.
2. Confirm **Privileged Gateway Intents** shows only `MESSAGE_CONTENT` enabled (and `SERVER_MEMBERS` or `PRESENCE` only if the personality needs them).
3. Check the bot's role in your server -- it should have no additional permissions beyond what the invite URL granted.

### 4. GitHub

Use **fine-grained Personal Access Tokens** (PATs). Classic PATs grant access to every repo the user owns -- they are the anti-pattern.

#### Create a fine-grained PAT

1. Go to **https://github.com/settings/personal-access-tokens/new**.
2. Under **Repository access**, select **Only select repositories** and pick the specific repos the agent needs.
3. Set permissions:

| Permission | Access level | When to use |
|---|---|---|
| `Contents` | Read-only | Default for all agents |
| `Contents` | Read and write | Only if the agent creates commits or PRs |
| `Issues` | Read-only | If the agent reads issue context |
| `Issues` | Read and write | If the agent triages or comments on issues |
| `Pull requests` | Read and write | If the agent creates or reviews PRs |
| `Metadata` | Read-only | Always required (GitHub enforces this) |

4. Set an expiration. Prefer the shortest interval your workflow tolerates (30 or 60 days). Rotate before expiry.

#### Anti-pattern: classic PATs

Classic PATs (`ghp_*`) grant blanket access to every repository the user can see. They cannot be scoped to specific repos, and they cannot be limited to read-only on a per-resource basis. Do not use them. If your agent currently uses a classic PAT, migrate to a fine-grained PAT.

#### Verify

```bash
# Check the scopes on a fine-grained PAT
curl -s -H "Authorization: Bearer github_pat_YOUR_TOKEN" \
  https://api.github.com/repos/OWNER/REPO | jq '.permissions'
```

Confirm the response returns only the permissions you selected.

### 5. Linear

Linear issues personal API keys at the user level. There is no per-team PAT scoping.

#### Create a scoped key

1. Go to **Settings > API** in your Linear workspace (or **https://linear.app/YOUR_WORKSPACE/settings/api**).
2. Create a **Personal API key**.
3. Label it with the agent's name and purpose (e.g., `ethos-triage-bot-readonly`).

#### Mitigation: use a service account

Because Linear API keys inherit the creating user's access to all teams in the workspace, create a dedicated **service account** (a separate Linear user) that belongs only to the teams the agent needs. This narrows the blast radius:

- Create a new Linear user (e.g., `ethos-bot@yourcompany.com`).
- Add it only to the target team(s).
- Generate the API key from that user's account.
- Do not add the service account to admin or owner roles.

#### Verify

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ teams { nodes { name } } }"}' | jq '.data.teams.nodes'
```

Confirm the response lists only the team(s) the service account belongs to.

### 6. Notion

Notion uses **internal integrations** with page-level sharing controls.

#### Create a minimally scoped integration

1. Go to **https://www.notion.so/my-integrations** and click **New integration**.
2. Choose **Internal integration** (not public). Internal integrations are scoped to your workspace and do not require OAuth.
3. On the **Capabilities** tab, set the minimum permissions:

| Capability | Enable? | When |
|---|---|---|
| Read content | Yes | Always |
| Update content | Only if needed | If the agent writes to Notion pages |
| Insert content | Only if needed | If the agent creates new blocks |
| Read comments | Only if needed | If the agent reads page comments |
| Read user information | No | Unless the agent resolves user mentions |

4. Click **Save changes**.

#### Share only the pages the agent needs

Notion integrations see **nothing** by default. You must explicitly share each page or database:

1. Open the target page in Notion.
2. Click **Share** (top right) > **Invite** > select the integration by name.
3. Repeat for each page or database. Child pages inherit the share automatically.

Do **not** share the root workspace page. Share the specific pages the agent operates on.

#### Verify

```bash
curl -s https://api.notion.com/v1/search \
  -H "Authorization: Bearer secret_YOUR_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -d '{"page_size": 100}' | jq '.results | length'
```

Confirm the count matches the number of pages you explicitly shared -- not the total pages in the workspace.

### 7. General principle: when in doubt

Start with the narrowest access and widen only when a specific capability fails:

1. **Begin with read-only.** Grant write access only after confirming the agent's personality and toolset require it.
2. **Add scopes one at a time.** Each new scope should trace to a specific tool or personality capability. If you cannot name the tool that needs a scope, the scope should not be there.
3. **Use service accounts.** Tokens attached to a human's account inherit that human's full access. A dedicated service account limits the blast radius.
4. **Set expiration dates.** Prefer short-lived tokens (30-90 days) and rotate before expiry.
5. **Audit via observability.db.** Every channel interaction and tool call is logged. Query the audit table to confirm the agent never exercises a capability it should not have:

```sql
SELECT timestamp, category, detail
FROM audit
WHERE category IN ('channel.allow', 'channel.deny', 'audit.block')
ORDER BY timestamp DESC
LIMIT 50;
```

6. **Review after each personality change.** When a personality gains new tools or a wider `fs_reach`, re-check whether the backing tokens still match the minimum needed.

For the full pre-launch hardening process, see the [production hardening checklist](./production-hardening-checklist.md). For the complete catalogue of channel-layer and tool-layer controls, see [security controls](./controls.md).
