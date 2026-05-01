import type { AgentLoop } from '@ethosagent/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { listPersonalities, listPersonalitiesToolDef } from './tools/list-personalities';
import { searchMemory, searchMemoryToolDef } from './tools/search-memory';

export interface EthosMcpServerConfig {
  loop: AgentLoop;
  dataDir: string;
  logger: McpLogger;
  version?: string;
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
    const { loop, dataDir, logger } = this._config;

    this._server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [askPersonalityToolDef, listPersonalitiesToolDef, searchMemoryToolDef],
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
}
