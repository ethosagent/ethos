import { createServer as createHttpServer } from 'node:http';
import type { AgentLoop } from '@ethosagent/core';
import type { SessionStore } from '@ethosagent/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpLogger } from './logger';
import { getPromptMessages, PROMPTS } from './prompts';
import { listResources, readResource } from './resources';
import { askPersonality, askPersonalityToolDef } from './tools/ask-personality';
import { getMessages, getMessagesToolDef } from './tools/get-messages';
import { getSession, getSessionToolDef } from './tools/get-session';
import { listPersonalities, listPersonalitiesToolDef } from './tools/list-personalities';
import { listSessions, listSessionsToolDef } from './tools/list-sessions';
import { searchMemory, searchMemoryToolDef } from './tools/search-memory';
import { searchSessions, searchSessionsToolDef } from './tools/search-sessions';

export interface EthosMcpServerConfig {
  loop: AgentLoop;
  dataDir: string;
  logger: McpLogger;
  version?: string;
  sessionStore?: SessionStore;
}

export class EthosMcpServer {
  private _server: Server;
  private _config: EthosMcpServerConfig;

  constructor(config: EthosMcpServerConfig) {
    this._config = config;
    this._server = new Server(
      { name: 'ethos', version: config.version ?? 'dev' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    this._registerHandlers();
  }

  private _registerHandlers(): void {
    const { loop, dataDir, logger, sessionStore } = this._config;

    const sessionToolDefs = sessionStore
      ? [listSessionsToolDef, getSessionToolDef, getMessagesToolDef, searchSessionsToolDef]
      : [];

    this._server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        askPersonalityToolDef,
        listPersonalitiesToolDef,
        searchMemoryToolDef,
        ...sessionToolDefs,
      ],
    }));

    this._server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const safeArgs = (args ?? {}) as Record<string, string>;

      logger.info('tool_call', { name, args: safeArgs });

      try {
        if (name === 'ask_personality') {
          const result = await askPersonality(loop, {
            personality_id: safeArgs.personality_id ?? '',
            prompt: safeArgs.prompt ?? '',
            session_key: safeArgs.session_key,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: result.text,
              },
            ],
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
          const results = searchMemory(
            dataDir,
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

        if (name === 'list_sessions') {
          if (!sessionStore) {
            return {
              content: [
                { type: 'text' as const, text: 'Session store not configured' },
              ],
              isError: true,
            };
          }
          const limit = Number(safeArgs.limit) || 20;
          const result = await listSessions(sessionStore, limit);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (name === 'get_session') {
          if (!sessionStore) {
            return {
              content: [
                { type: 'text' as const, text: 'Session store not configured' },
              ],
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
              content: [
                { type: 'text' as const, text: 'Session store not configured' },
              ],
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
              content: [
                { type: 'text' as const, text: 'Session store not configured' },
              ],
              isError: true,
            };
          }
          const query = safeArgs.query ?? '';
          const limit = Number(safeArgs.limit) || 10;
          const result = await searchSessions(sessionStore, query, limit);
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

    this._server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: listResources(dataDir),
    }));

    this._server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      logger.info('resource_read', { uri });
      const text = readResource(uri, dataDir);
      return {
        contents: [{ uri, mimeType: 'text/plain', text }],
      };
    });

    this._server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: PROMPTS,
    }));

    this._server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const safeArgs = (args ?? {}) as Record<string, string>;
      logger.info('prompt_get', { name });
      const messages = getPromptMessages(name, safeArgs);
      return { messages };
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this._server.connect(transport);
    this._config.logger.info('mcp_server_started', { transport: 'stdio' });
  }

  async serveHttp(opts: { port: number; host?: string }): Promise<void> {
    const host = opts.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      throw new Error(
        'MCP HTTP server only binds to loopback (127.0.0.1). Non-loopback binds are not supported until an auth story ships.',
      );
    }

    const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

    const httpServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: InstanceType<typeof StreamableHTTPServerTransport>;
        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId) as typeof transport;
        } else {
          const id = crypto.randomUUID();
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
          transports.set(id, transport);
          await this._server.connect(transport);
          transport.onclose = () => transports.delete(id);
        }
        await transport.handleRequest(req, res);
        return;
      }
      // Health check
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    return new Promise((resolve, reject) => {
      httpServer.on('error', reject);
      httpServer.listen(opts.port, host, () => {
        this._config.logger.info('mcp_server_started', {
          transport: 'streamable-http',
          host,
          port: opts.port,
        });
        resolve();
      });
    });
  }
}
