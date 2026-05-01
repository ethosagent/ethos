# Ethos MCP — Claude Desktop

This example shows how to connect Ethos as an MCP server to Claude Desktop.

## Quick install

```bash
ethos mcp install claude-desktop
```

This writes the Ethos MCP entry into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

Restart Claude Desktop to pick up the new server.

## Manual config

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ethos": {
      "command": "node",
      "args": ["/path/to/ethos-cli", "mcp", "serve"]
    }
  }
}
```

Replace `/path/to/ethos-cli` with the path to the `ethos` binary (run `which ethos` to find it).

## Available tools

| Tool | Description |
|------|-------------|
| `ask_personality` | Run a prompt through any Ethos personality |
| `list_personalities` | List all available personalities |
| `search_memory` | Search agent memory files |

## Available prompts

- **code_review** — Structured code review
- **research_topic** — Deep research with citations
- **reflect_on_decision** — Coaching reflection
- **debug_failure** — Evidence-first failure investigation
