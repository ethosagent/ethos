---
title: "Least-privilege tokens: GitHub, Linear and Notion"
description: "Minimal scopes for GitHub, Linear and Notion integration tokens."
kind: how-to
audience: shared
time: "10 min"
updated: 2026-11-03
---

## Task

Mint minimally scoped tokens for the GitHub, Linear and Notion integrations.

## Result

Every step on this page is applied and the checks in [Verify](../least-privilege-tokens.md#verify) on the main page pass.

## Prereqs

Complete the [Prereqs](../least-privilege-tokens.md#prereqs) listed on the main page, [Least-privilege token cookbook](../least-privilege-tokens.md).

## Steps

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

## Verify

Run the [Verify](../least-privilege-tokens.md#verify) steps on the main page once all parts are done.

## Troubleshoot

A scope-error response from a provider means the token is too narrow. Widen only the specific scope that failed; see [Verify](../least-privilege-tokens.md#verify).
