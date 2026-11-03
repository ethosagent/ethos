---
title: "Use the web dashboard: cron, MCP, chat and admin"
description: "Manage cron jobs and MCP servers, chat, reach the dashboard remotely, use widgets, the admin panel and learned changes."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Run day-to-day operations from the web dashboard: cron jobs, MCP servers, chat, remote access, widgets, the admin panel and learned-change review.

## Result

You can manage scheduled jobs and MCP connections, chat with a personality, reach the dashboard from another machine, and review learned changes, all from the browser.

## Prereqs

- Complete [steps 1-5](../use-web-dashboard.md): the dashboard is running at `http://localhost:3000`.
- For MCP OAuth: an MCP server URL that supports OAuth, or a stdio or bearer-token server.

## Steps

### 6. Manage cron jobs

Navigate to the **Cron** tab. The table lists all scheduled jobs across all personalities.

| Column | Content |
|---|---|
| **Name** | Human-readable job label. |
| **Personality** | The personality the job runs under. |
| **Schedule** | Cron expression (e.g. `0 8 * * 1-5`). |
| **Status** | `active` or `paused`. |
| **Next run** | Timestamp of the next scheduled firing. |
| **Last run** | Timestamp and status of the most recent execution. |

Actions available per job:

- **Run now** — fire the job immediately, outside its schedule.
- **Pause / Resume** — toggle the job's active state.
- **View history** — expand to see past runs with timestamps and output.
- **Remove** — permanently delete the job.

To create a new job, use the chat interface — the cron tool is agent-callable, not form-driven. See [Schedule tasks with cron](../schedule-tasks-with-cron.md) for the full workflow.

### 7. Add and manage MCP servers

Navigate to the **MCP** tab. Click **Add MCP Server** to register a new server.

For OAuth-protected servers:

1. Enter the server URL (e.g. `https://mcp.linear.app`).
2. The UI runs OAuth discovery and displays the server's metadata.
3. Select a personality from the dropdown — the token will be stored under this personality's path.
4. Click **Connect** to start the PKCE flow in a new tab.
5. After authorising, the token lands at `~/.ethos/personalities/<id>/mcp/<name>/`.

For stdio or bearer-token servers, the form collects the command, args, and headers. No OAuth flow is needed.

The MCP tab also shows:

- **Connection status** per server per personality.
- **Token expiry** for OAuth-authenticated servers.
- A **Disconnect** button that revokes the token and removes the stored credential.

### 8. Chat with a personality

Navigate to the **Chat** tab. Type a message and press Enter.

A session belongs to the personality it started with. The bar at the top of the chat shows which one that is — accent stripe, mark, name, and model — and there is no control to change it mid-conversation. To talk to a different personality, click **+** in that bar (or press ⌘K and choose **New chat session**) and pick one in the New Session picker. The previous conversation stays in the **Sessions** tab, still under its own personality.

The chat view streams the agent's response in real time, showing tool calls inline with expandable detail panels. Each tool call shows the tool name, arguments, and result. Slash commands work the same as in the CLI:

| Command | Effect |
|---|---|
| `/new` | Start a fresh session (clears conversation history). |
| `/skills` | List skills the active personality can access. |
| `/memory` | Show the active personality's memory summary. |

The session persists across page reloads — the dashboard reads from the same `SessionStore` the CLI uses. Starting a `/new` session in the dashboard is visible to `ethos chat` and vice versa.

### 9. Remote access

The dashboard binds to `localhost` by default. For remote access, use an SSH tunnel rather than exposing the port directly:

```bash
# On your local machine
ssh -L 3000:localhost:3000 user@remote-host
```

Then open `http://localhost:3000` locally. The tunnel forwards all traffic securely.

For production deployments behind a reverse proxy (nginx, Caddy), point the proxy at `localhost:3000` on the host. The dashboard serves all assets from a single origin — no CORS configuration is needed. See [Deploy in production](../deploy-in-production.md) for the full reverse-proxy setup.

The dashboard does not implement its own authentication. Access control relies on the network boundary (SSH tunnel, VPN, or reverse proxy with auth). Do not expose port 3000 to the public internet without an authentication layer in front.

### 10. Use dashboards

Dashboards display data from plugin data sources as customizable panels.

Navigate to the **Dashboards** tab.

Click **Add widget** to see available widget templates. Plugins that ship a `widgets.yaml` contribute pre-built panels — each shows a title, description, and plugin badge. Click a template to create a panel pre-filled with the template's SQL query.

The dashboard runs read-only SQL against plugin-registered SQLite databases. Mutating queries (`INSERT`, `UPDATE`, `DELETE`, `DROP`) are rejected with a `READONLY_QUERY_ONLY` error.

### 11. Navigate the admin panel

Navigate to `/admin` for operational management. The admin panel has three tabs:

- **Channels** — view configured channel adapter status and webhook URLs.
- **API Keys** — check LLM provider health and rotate API keys.
- **MCP Servers** — add or remove MCP server connections.

For the full walkthrough, see [Use the admin panel](../use-admin-panel.md).

### 12. Review learned changes

Open **Learning** in the Library section of the sidebar. Its count badge shows how many candidates a replay has measured that wait on you. The page lists every skill and Expression candidate, grouped into **Needs review**, **Waiting for replay**, **Promoted**, and **Rejected & rolled back**.

Select a candidate to see its evidence, diff, replay scorecard and timeline. For an Expression, the diff shows the Core greyed and locked above the change.

Click **Approve** to promote a candidate that passed its replay. On any other verdict the button reads **Approve anyway…** and asks for a reason first; the reason is recorded in the audit log.

Click **Reject…** to mark a candidate rejected. No live file changes, and the candidate stays visible under **Rejected & rolled back**.

Click **Run replay** to measure a waiting candidate now. On a promoted candidate, **Rollback** undoes the promotion. When rollback is not allowed, the button is disabled and the reason is shown beside it.

The Skills page's **Approval queue** tab links to this page, filtered to skills. A personality's **Living Soul** section links to that personality's waiting candidates.

For the full workflow, see [Manage skill evolution](../manage-skill-evolution.md).

### 13. Handle background notifications

When a background process completes, a notification appears inline in the chat. Failed processes include the last 1000 characters of stderr.

If you're offline when a process completes, the notification is buffered and delivered when you next open a session.

## Verify

Open the **Cron** tab — scheduled jobs appear in the table with their next run. Open the **MCP** tab — each registered server shows its connection status. Open **Chat**, send `/memory` — the active personality's memory summary appears.

## Troubleshoot

**Cron tab shows no jobs** — No cron jobs have been created. Use the chat interface to create one — see [Schedule tasks with cron](../schedule-tasks-with-cron.md).

**MCP OAuth redirect fails** — The browser cannot reach the OAuth provider's authorization endpoint. Check your network connection. If running remotely via SSH tunnel, ensure the tunnel forwards the callback port as well.

## See also

- [Use the web dashboard](../use-web-dashboard.md) — steps 1-5 and the rest of the troubleshooting.
- [Schedule tasks with cron](../schedule-tasks-with-cron.md) — create and manage cron jobs via the agent.
- [Set up MCP for a personality](../set-up-mcp-for-a-personality.md) — detailed MCP OAuth walkthrough for both web and CLI paths.
