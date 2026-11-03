---
title: Least-privilege token cookbook
description: Per-provider instructions for minting minimally scoped tokens for Slack, Telegram, Discord, GitHub, Linear, and Notion integrations.
kind: how-to
audience: shared
slug: least-privilege-tokens
time: "15 min"
updated: 2026-11-03
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

The steps continue on the subpages below; run them in order.

| Section | Page |
| --- | --- |
| <a id="1-slack"></a>[1. Slack](least-privilege-tokens/chat-platforms.md#1-slack) | [Least-privilege tokens: Slack, Telegram and Discord](least-privilege-tokens/chat-platforms.md) |
| <a id="2-telegram"></a>[2. Telegram](least-privilege-tokens/chat-platforms.md#2-telegram) | [Least-privilege tokens: Slack, Telegram and Discord](least-privilege-tokens/chat-platforms.md) |
| <a id="3-discord"></a>[3. Discord](least-privilege-tokens/chat-platforms.md#3-discord) | [Least-privilege tokens: Slack, Telegram and Discord](least-privilege-tokens/chat-platforms.md) |
| <a id="4-github"></a>[4. GitHub](least-privilege-tokens/work-tools.md#4-github) | [Least-privilege tokens: GitHub, Linear and Notion](least-privilege-tokens/work-tools.md) |
| <a id="5-linear"></a>[5. Linear](least-privilege-tokens/work-tools.md#5-linear) | [Least-privilege tokens: GitHub, Linear and Notion](least-privilege-tokens/work-tools.md) |
| <a id="6-notion"></a>[6. Notion](least-privilege-tokens/work-tools.md#6-notion) | [Least-privilege tokens: GitHub, Linear and Notion](least-privilege-tokens/work-tools.md) |

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

## Verify

Run `ethos personality show <id>` for each personality. The character sheet surfaces the configured MCP servers and their declared scopes. Cross-reference against the minimum scopes listed above.

Check `observability.db` for `audit.tool_call` events -- any scope-error responses from external APIs indicate a token that is too narrow. Widen only the specific scope that failed.

For the full pre-launch hardening process, see the [production hardening checklist](./production-hardening-checklist.md). For the complete catalogue of channel-layer and tool-layer controls, see [security controls](./controls.md).
