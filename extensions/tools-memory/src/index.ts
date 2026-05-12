import type {
  MemoryContext,
  MemoryProvider,
  SessionStore,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

export function createMemoryReadTool(memory: MemoryProvider): Tool {
  return {
    name: 'memory_read',
    description:
      'Read the current memory files (MEMORY.md and USER.md). Use to recall past context, user preferences, or project notes before starting a new task.',
    toolset: 'memory',
    maxResultChars: 20_000,
    schema: {
      type: 'object',
      properties: {
        store: {
          type: 'string',
          enum: ['memory', 'user', 'both'],
          description: 'Which memory file to read (default: both)',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { store = 'both' } = args as { store?: 'memory' | 'user' | 'both' };

      const memCtx = buildMemoryContext(ctx);
      const snapshot = await memory.prefetch(memCtx);

      if (!snapshot || snapshot.entries.length === 0) {
        return { ok: true, value: 'Memory is empty. No notes recorded yet.' };
      }

      const byKey = new Map(snapshot.entries.map((e) => [e.key, e.content]));

      if (store === 'memory') {
        const content = byKey.get('MEMORY.md');
        return { ok: true, value: content?.trim() || 'MEMORY.md is empty.' };
      }
      if (store === 'user') {
        const content = byKey.get('USER.md');
        return { ok: true, value: content?.trim() || 'USER.md is empty.' };
      }

      const parts: string[] = [];
      const user = byKey.get('USER.md');
      if (user) parts.push(`## About You\n\n${user.trim()}`);
      const mem = byKey.get('MEMORY.md');
      if (mem) parts.push(`## Memory\n\n${mem.trim()}`);
      return { ok: true, value: parts.join('\n\n') };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_write
// ---------------------------------------------------------------------------

export function createMemoryWriteTool(memory: MemoryProvider): Tool {
  return {
    name: 'memory_write',
    description:
      'Update the memory files. Use "add" to append a new fact, "replace" to overwrite the entire file, "remove" to delete a specific line. The "memory" store holds project context; "user" holds information about the user.',
    toolset: 'memory',
    schema: {
      type: 'object',
      properties: {
        store: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which file to update: "memory" = MEMORY.md, "user" = USER.md',
        },
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove'],
          description: '"add" appends, "replace" overwrites, "remove" deletes matching lines',
        },
        content: {
          type: 'string',
          description: 'Content to add/replace (or the line to search for when action="remove")',
        },
        substring_match: {
          type: 'string',
          description: 'For action="remove": delete lines containing this substring',
        },
      },
      required: ['store', 'action', 'content'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { store, action, content, substring_match } = args as {
        store: 'memory' | 'user';
        action: 'add' | 'replace' | 'remove';
        content: string;
        substring_match?: string;
      };

      if (!store || !['memory', 'user'].includes(store)) {
        return { ok: false, error: 'store must be "memory" or "user"', code: 'input_invalid' };
      }
      if (!action || !['add', 'replace', 'remove'].includes(action)) {
        return {
          ok: false,
          error: 'action must be "add", "replace", or "remove"',
          code: 'input_invalid',
        };
      }

      const memCtx = buildMemoryContext(ctx);
      const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';

      if (action === 'remove') {
        const match = substring_match ?? content;
        await memory.sync([{ action: 'remove', key, substringMatch: match }], memCtx);
      } else {
        await memory.sync([{ action, key, content }], memCtx);
      }

      const verb = action === 'add' ? 'Appended to' : action === 'replace' ? 'Replaced' : 'Updated';
      return { ok: true, value: `${verb} ${key}` };
    },
  };
}

// ---------------------------------------------------------------------------
// session_search
// ---------------------------------------------------------------------------

export function createSessionSearchTool(session: SessionStore): Tool {
  return {
    name: 'session_search',
    description:
      'Search the session history using full-text search. Returns messages matching the query across all sessions.',
    toolset: 'memory',
    maxResultChars: 10_000,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { query, limit } = args as { query: string; limit?: number };

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      const results = await session.search(query, {
        limit: Math.min(limit ?? 10, 50),
        sessionId: ctx.sessionId,
      });

      if (results.length === 0) {
        return { ok: true, value: `No session history matches "${query}"` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. [${r.timestamp.toISOString().slice(0, 16)}] ${r.snippet}`)
        .join('\n\n');

      return {
        ok: true,
        value: `${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryTools(memory: MemoryProvider, session: SessionStore): Tool[] {
  return [
    createMemoryReadTool(memory),
    createMemoryWriteTool(memory),
    createSessionSearchTool(session),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMemoryContext(ctx: ToolContext): MemoryContext {
  const scopeId =
    ctx.memoryScopeId ??
    (ctx.memoryScope === 'per-personality' && ctx.personalityId
      ? `personality:${ctx.personalityId}`
      : 'global');
  return {
    scopeId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir ?? '',
  };
}
