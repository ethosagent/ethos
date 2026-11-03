# @ethosagent/mcp-server

## Purpose

Hosts Ethos as a Model Context Protocol server. `EthosMcpServer` is the operator console: it exposes personalities, sessions and memory as MCP tools, resources and prompts over stdio or Streamable HTTP. `PersonalityExportServer` publishes one personality to one external client through a single `ask` tool. The package also ships config-entry adapters for five MCP clients.

## Public surface

This is an app (private, no binary; `src/index.ts` is the entry module). Entry points:

| Export | Kind | One line |
|---|---|---|
| `EthosMcpServer` | class | Operator-console MCP server (full trust, every personality). |
| `PersonalityExportServer` | class | Default-deny server for one personality; registers one tool, `ask`. |
| `serveMcpHttp` | function | Streamable-HTTP hosting, one `Server` per session. |
| `askPersonality` | function | Tool `ask_personality`: runs a turn against a personality. |
| `listPersonalities` | function | Tool `list_personalities`. |
| `listSessions` | function | Tool `list_sessions`. |
| `getSession` | function | Tool `get_session`. |
| `getMessages` | function | Tool `get_messages`. |
| `searchSessions` | function | Tool `search_sessions`. |
| `readMemory` | function | Tool `read_memory`. |
| `searchMemory` | function | Tool `search_memory`. |
| `writeMemory` | function | Tool `write_memory`. |
| `listResources` | function | MCP resources listing. |
| `readResource` | function | MCP resource read. |
| `PROMPTS` | const | MCP prompt definitions. |
| `collectTurnResult` | function | Folds a turn's events into a result, including `error` and `halt`. |
| `personalityMemoryContext` | function | Resolves the memory context for a personality. |
| `exportSessionKey` | function | Builds the `mcp:<id>:<clientId>:<conversation>` session key. |
| `claudeDesktop` | const | Client adapter. Siblings: `continueClient`, `cursor`, `opencode`, `zed`. |

Plus the logger, types and audit helpers; see `src/index.ts`.

## Seam

Layer: apps (`apps/*/src/**` in `architecture.config.ts`); `apps/mcp-server/src/index.ts` is an `app-entry` module under `app-entry-modules-compose`. Law 5 (apps do not bypass wiring), enforced by archcheck `l5-apps-through-wiring`. Per-personality export is deliberately a separate class from the console so a tool added to one cannot leak into the other (design note in `src/export-server.ts`).

## Testing

```
pnpm vitest run apps/mcp-server
```

Pinning tests (`src/__tests__/`):

- `export-server.test.ts`: the export server over the SDK in-memory transport.
- `export-http.test.ts`: the export over Streamable HTTP.
- `serve-http.test.ts`: one `Server` per HTTP session; loopback DNS-rebinding protection.
- `client-entries.test.ts`: `McpEntry.name` and `env` across all five client adapters.
- `memory-scope.test.ts`: memory tools read personality-scoped memory.
- `turn-result.test.ts`: a refused turn is not an empty success.
- `ask-personality.test.ts`, `session-tools.test.ts`, `server.test.ts`: tool behaviour.
