---
title: "Slash commands: /mcp sign-in from chat"
description: "The /mcp login, code and cancel commands: sign in to an OAuth MCP server from a chat channel, with requirements and replies."
kind: reference
audience: user
updated: 2026-11-14
---

## Synopsis {#synopsis}

Sign-in to OAuth MCP servers from a chat channel. Part of the [slash commands reference](../slash-commands.md).

## /mcp {#slash-mcp}

Sign in to an OAuth [MCP](../mcp-config.md) server from a chat channel, for the bot's current [personality](../../../getting-started/glossary.md#personality). Gateway only. Handled before the agent: the model never sees these messages.

Synopsis: `/mcp login <server>` · `/mcp code <address>` · `/mcp cancel`

| Form | Effect |
|---|---|
| `/mcp login <server>` | Replies with a code and a verification URL (device sign-in), or an authorize URL if the server has no device grant. |
| `/mcp code <address>` | Paste sign-in only: send the `127.0.0.1` address your browser ended on. A rejected address can be sent again. |
| `/mcp cancel` | Cancels the pending sign-in for this chat. |

Requirements, checked in this order; the first failure replies and starts nothing:

| Check | Reply when it fails |
|---|---|
| The gateway has MCP sign-in wired | `MCP sign-in is not available on this gateway.` |
| The bot is bound to a personality, not a team | `Sign in from the CLI for team bots.` |
| `channel_filter.<platform>.ownerUserId` is set in `config.yaml` | `Set channel_filter.<platform>.ownerUserId in config.yaml.` |
| The sender is that owner | `Only the owner may sign in to MCP servers.` |
| The message is a direct message with a private audience | `Send /mcp login to me in a direct message.` |
| No sign-in is already waiting in this chat | `A sign-in is already waiting. Send /mcp cancel first.` |
| The server is in the personality's `mcp_servers:` | `'<server>' is not attached to <id>. Attach it first: ethos personality mcp <id> --attach <server>.` |

The reply goes to the chat the owner wrote from, and a final line reports connected, declined, expired, cancelled or failed. Pasted text is never echoed back.

```text
> /mcp login granola
Sign in to granola for personality "engineer"
Server: mcp.granola.ai · Authorization: mcp-auth.granola.ai
Open https://mcp-auth.granola.ai/device and enter ABCD-EFGH-J
Expires in 5 min. If you did not just send /mcp login, ignore this message.
```

Source: `handleMcpCommand` in [`extensions/gateway/src/index.ts`](../../../../../extensions/gateway/src/index.ts).

## See also {#see-also}

- [Slash commands reference](../slash-commands.md): the index of every command.
- [MCP config reference](../mcp-config.md): `~/.ethos/mcp.json` and sign-in options.
