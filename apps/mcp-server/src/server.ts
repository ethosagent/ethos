import { type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import type { MemoryProvider, SessionStore, Storage } from '@ethosagent/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type McpHttpHandle, serveMcpHttp } from './http-session';
import type { McpLogger } from './logger';
import { getPromptMessages, PROMPTS } from './prompts';
import { listResources, type ResourceDeps, readResource } from './resources';
import { askPersonality, askPersonalityToolDef } from './tools/ask-personality';
import { getMessages, getMessagesToolDef } from './tools/get-messages';
import { getSession, getSessionToolDef } from './tools/get-session';
import { listPersonalities, listPersonalitiesToolDef } from './tools/list-personalities';
import { listSessions, listSessionsToolDef } from './tools/list-sessions';
import { readMemory, readMemoryToolDef } from './tools/read-memory';
import { searchMemory, searchMemoryToolDef } from './tools/search-memory';
import { searchSessions, searchSessionsToolDef } from './tools/search-sessions';
import { writeMemory, writeMemoryToolDef } from './tools/write-memory';

export interface EthosMcpServerConfig {
  loop: AgentLoop;
  dataDir: string;
  /** Reads under `dataDir` go through this — CLAUDE.md, "Storage abstraction". */
  storage: Storage;
  logger: McpLogger;
  version?: string;
  sessionStore?: SessionStore;
  /** Absent → the memory tools and memory resources are not exposed. */
  memoryProvider?: MemoryProvider;
  enableMemoryWrite?: boolean;
}

export class EthosMcpServer {
  private _server: Server;
  private _config: EthosMcpServerConfig;
  private _watchers: FSWatcher[] = [];
  /** Live per-HTTP-session servers, for resource-update broadcast. */
  private _sessionServers = new Set<Server>();
  private _http: McpHttpHandle | null = null;

  constructor(config: EthosMcpServerConfig) {
    this._config = config;
    this._server = this._createServer();

    if (config.memoryProvider) {
      // `watch` has no Storage equivalent — it is a change notification, not a
      // read; no bytes reach this process through it. Personality memory lives
      // at `<dataDir>/personalities/<id>/`, so the watch is recursive and the
      // notified URI names the personality (`resources.ts`).
      try {
        const watcher = watch(
          join(config.dataDir, 'personalities'),
          { recursive: true },
          (_event, filename) => {
            if (!filename) return;
            const match = filename.match(/^([^/\\]+)[/\\]([^/\\]+\.md)$/);
            if (!match) return;
            this._broadcastResourceUpdated(`ethos://memory/${match[1]}/${match[2]}`);
          },
        );
        this._watchers.push(watcher);
      } catch {
        // personalities dir may not exist yet
      }
    }
  }

  private _broadcastResourceUpdated(uri: string): void {
    for (const server of [this._server, ...this._sessionServers]) {
      // Throws when that server has no transport connected (stdio server while
      // serving HTTP, and vice versa) — not an error worth surfacing.
      server.sendResourceUpdated({ uri }).catch(() => {});
    }
  }

  private _resourceDeps(): ResourceDeps {
    const { dataDir, storage, memoryProvider } = this._config;
    return { dataDir, storage, ...(memoryProvider ? { memoryProvider } : {}) };
  }

  /**
   * Build one MCP `Server` with every handler registered.
   *
   * One per transport session, never shared: SDK 1.29.0's `Protocol.connect`
   * throws `Already connected to a transport` on a second call (`http-session.ts`).
   */
  private _createServer(): Server {
    const config = this._config;
    const server = new Server(
      { name: 'ethos', version: config.version ?? 'dev' },
      {
        capabilities: {
          tools: {},
          resources: config.memoryProvider ? { subscribe: true } : {},
          prompts: {},
        },
      },
    );
    this._registerHandlers(server);
    return server;
  }

  private _registerHandlers(server: Server): void {
    const { loop, dataDir, logger, sessionStore, memoryProvider, enableMemoryWrite } = this._config;

    const sessionToolDefs = sessionStore
      ? [listSessionsToolDef, getSessionToolDef, getMessagesToolDef, searchSessionsToolDef]
      : [];

    const memoryToolDefs = memoryProvider
      ? [searchMemoryToolDef, readMemoryToolDef, ...(enableMemoryWrite ? [writeMemoryToolDef] : [])]
      : [];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        askPersonalityToolDef,
        listPersonalitiesToolDef,
        ...sessionToolDefs,
        ...memoryToolDefs,
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const safeArgs = (args ?? {}) as Record<string, string>;

      logger.info('tool_call', { name, args: safeArgs });

      try {
        if (name === 'ask_personality') {
          const result = await askPersonality(loop, {
            personality_id: safeArgs.personality_id ?? '',
            prompt: safeArgs.prompt ?? '',
            ...(safeArgs.conversation !== undefined ? { conversation: safeArgs.conversation } : {}),
          });
          // The conversation id rides along so the client can continue this
          // conversation without naming a session key of its own.
          const handle = {
            type: 'text' as const,
            text: JSON.stringify({ conversation: result.conversation }),
          };
          if (result.error) {
            return {
              content: [
                { type: 'text' as const, text: `${result.error.code}: ${result.error.message}` },
                ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
                handle,
              ],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text' as const, text: result.text }, handle],
          };
        }

        if (name === 'list_personalities') {
          const personalities = listPersonalities(dataDir);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(personalities, null, 2),
              },
            ],
          };
        }

        if (name === 'search_memory') {
          if (!memoryProvider) {
            return {
              content: [{ type: 'text' as const, text: 'Memory provider not configured' }],
              isError: true,
            };
          }
          const results = await searchMemory(
            memoryProvider,
            safeArgs.personality_id ?? '',
            safeArgs.query ?? '',
            safeArgs.scope as 'memory' | 'user' | 'all' | undefined,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }

        if (name === 'read_memory') {
          if (!memoryProvider) {
            return {
              content: [{ type: 'text' as const, text: 'Memory provider not configured' }],
              isError: true,
            };
          }
          const result = await readMemory(
            memoryProvider,
            safeArgs.personality_id ?? '',
            safeArgs.key ?? '',
          );
          return { content: [{ type: 'text' as const, text: result }] };
        }

        if (name === 'write_memory') {
          if (!memoryProvider || !enableMemoryWrite) {
            return {
              content: [{ type: 'text' as const, text: 'Memory write not enabled' }],
              isError: true,
            };
          }
          const result = await writeMemory(
            memoryProvider,
            safeArgs.personality_id ?? '',
            safeArgs.action as 'add' | 'replace' | 'remove' | 'delete',
            safeArgs.key ?? '',
            safeArgs.content,
            safeArgs.substring_match,
          );
          const isError = result.startsWith('input_invalid');
          return {
            content: [{ type: 'text' as const, text: result }],
            ...(isError ? { isError: true } : {}),
          };
        }

        if (name === 'list_sessions') {
          if (!sessionStore) {
            return {
              content: [{ type: 'text' as const, text: 'Session store not configured' }],
              isError: true,
            };
          }
          const limit = Number(safeArgs.limit) || 20;
          const since = typeof safeArgs.since === 'string' ? safeArgs.since : undefined;
          const result = await listSessions(sessionStore, limit, since);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (name === 'get_session') {
          if (!sessionStore) {
            return {
              content: [{ type: 'text' as const, text: 'Session store not configured' }],
              isError: true,
            };
          }
          const id = safeArgs.id ?? '';
          const messageLimit = Number(safeArgs.messageLimit) || 50;
          const result = await getSession(sessionStore, id, messageLimit);
          if ('error' in result) {
            return {
              content: [{ type: 'text' as const, text: result.error }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (name === 'get_messages') {
          if (!sessionStore) {
            return {
              content: [{ type: 'text' as const, text: 'Session store not configured' }],
              isError: true,
            };
          }
          const sessionId = safeArgs.sessionId ?? '';
          const limit = Number(safeArgs.limit) || 50;
          const result = await getMessages(sessionStore, sessionId, limit);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (name === 'search_sessions') {
          if (!sessionStore) {
            return {
              content: [{ type: 'text' as const, text: 'Session store not configured' }],
              isError: true,
            };
          }
          const query = safeArgs.query ?? '';
          const limit = Number(safeArgs.limit) || 10;
          const since = typeof safeArgs.since === 'string' ? safeArgs.since : undefined;
          const until = typeof safeArgs.until === 'string' ? safeArgs.until : undefined;
          const result = await searchSessions(sessionStore, query, limit, since, until);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('tool_error', { name, error: msg });
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await listResources(this._resourceDeps()),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      logger.info('resource_read', { uri });
      const text = await readResource(uri, this._resourceDeps());
      return {
        contents: [{ uri, mimeType: 'text/plain', text }],
      };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: PROMPTS,
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const safeArgs = (args ?? {}) as Record<string, string>;
      logger.info('prompt_get', { name });
      const messages = getPromptMessages(name, safeArgs);
      return { messages };
    });

    if (this._config.memoryProvider) {
      server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
      server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
    }
  }

  async close(): Promise<void> {
    for (const w of this._watchers) {
      w.close();
    }
    this._watchers = [];
    if (this._http) {
      await this._http.close();
      this._http = null;
    }
    for (const server of [...this._sessionServers]) {
      await server.close().catch(() => {});
    }
    this._sessionServers.clear();
    await this._server.close();
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this._server.connect(transport);
    this._config.logger.info('mcp_server_started', { transport: 'stdio' });
  }

  /**
   * Serve over Streamable HTTP. One `Server` per session, DNS-rebinding
   * protection on — both live in `http-session.ts`, which the per-personality
   * MCP export shares.
   */
  async serveHttp(opts: { port: number; host?: string }): Promise<McpHttpHandle> {
    const handle = await serveMcpHttp({
      port: opts.port,
      ...(opts.host ? { host: opts.host } : {}),
      logger: this._config.logger,
      serverFactory: () => {
        const server = this._createServer();
        this._sessionServers.add(server);
        server.onclose = () => this._sessionServers.delete(server);
        return server;
      },
    });
    this._http = handle;
    return handle;
  }
}
