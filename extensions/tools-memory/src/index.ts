import { redactString } from '@ethosagent/safety-redact';
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
    capabilities: {},
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
        return { ok: true, value: redactString(content?.trim() ?? '') || 'MEMORY.md is empty.' };
      }
      if (store === 'user') {
        const content = byKey.get('USER.md');
        return { ok: true, value: redactString(content?.trim() ?? '') || 'USER.md is empty.' };
      }

      const parts: string[] = [];
      const user = byKey.get('USER.md');
      if (user) parts.push(`## About You\n\n${user.trim()}`);
      const mem = byKey.get('MEMORY.md');
      if (mem) parts.push(`## Memory\n\n${mem.trim()}`);
      return { ok: true, value: redactString(parts.join('\n\n')) };
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
    capabilities: {},
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
    capabilities: {},
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
        value: redactString(
          `${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}`,
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// team_memory_read
// ---------------------------------------------------------------------------

export function createTeamMemoryReadTool(teamMemory: MemoryProvider): Tool {
  return {
    name: 'team_memory_read',
    description:
      'Read a single team memory topic file. Use to load shared team knowledge before working on team tasks.',
    toolset: 'team_memory',
    maxResultChars: 20_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Topic file name, e.g. "architecture", "decisions", "onboarding"',
        },
      },
      required: ['key'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { key } = args as { key: string };
      if (!key) return { ok: false, error: 'key is required', code: 'input_invalid' };
      if (!isSafeTopicKey(key))
        return {
          ok: false,
          error: `invalid key "${key}": use alphanumeric, hyphens, underscores`,
          code: 'input_invalid',
        };
      if (!ctx.teamId)
        return { ok: false, error: 'no team context for this session', code: 'not_available' };

      const memCtx = buildTeamMemoryContext(ctx, ctx.teamId);
      const entry = await teamMemory.read(key.endsWith('.md') ? key : `${key}.md`, memCtx);
      if (!entry) return { ok: true, value: `No team memory entry for "${key}".` };
      return { ok: true, value: redactString(entry.content.trim()) || `"${key}" is empty.` };
    },
  };
}

// ---------------------------------------------------------------------------
// team_memory_write
// ---------------------------------------------------------------------------

export function createTeamMemoryWriteTool(teamMemory: MemoryProvider): Tool {
  return {
    name: 'team_memory_write',
    description:
      'Update a team memory topic file. "add" appends a fact, "replace" overwrites the topic, "remove" deletes matching lines, "delete" removes the topic entirely.',
    toolset: 'team_memory',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'delete'],
          description: 'Operation to apply',
        },
        key: {
          type: 'string',
          description: 'Topic file name, e.g. "architecture", "decisions"',
        },
        content: {
          type: 'string',
          description: 'Content to add or replace (required for add/replace)',
        },
        substring_match: {
          type: 'string',
          description: 'For action="remove": delete lines containing this substring',
        },
      },
      required: ['action', 'key'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { action, key, content, substring_match } = args as {
        action: 'add' | 'replace' | 'remove' | 'delete';
        key: string;
        content?: string;
        substring_match?: string;
      };

      if (!action || !['add', 'replace', 'remove', 'delete'].includes(action)) {
        return {
          ok: false,
          error: 'action must be "add", "replace", "remove", or "delete"',
          code: 'input_invalid',
        };
      }
      if (!key) return { ok: false, error: 'key is required', code: 'input_invalid' };
      if (!isSafeTopicKey(key))
        return {
          ok: false,
          error: `invalid key "${key}": use alphanumeric, hyphens, underscores`,
          code: 'input_invalid',
        };
      if (!ctx.teamId)
        return { ok: false, error: 'no team context for this session', code: 'not_available' };
      if ((action === 'add' || action === 'replace') && !content) {
        return {
          ok: false,
          error: `content is required for action="${action}"`,
          code: 'input_invalid',
        };
      }
      if (action === 'remove' && !substring_match) {
        return {
          ok: false,
          error: 'substring_match is required for action="remove"',
          code: 'input_invalid',
        };
      }

      const fileKey = key.endsWith('.md') ? key : `${key}.md`;
      const memCtx = buildTeamMemoryContext(ctx, ctx.teamId);

      if (action === 'remove') {
        const match = substring_match ?? '';
        await teamMemory.sync([{ action: 'remove', key: fileKey, substringMatch: match }], memCtx);
      } else if (action === 'delete') {
        await teamMemory.sync([{ action: 'delete', key: fileKey }], memCtx);
      } else {
        await teamMemory.sync([{ action, key: fileKey, content: content ?? '' }], memCtx);
      }

      const verb =
        action === 'add'
          ? 'Appended to'
          : action === 'replace'
            ? 'Replaced'
            : action === 'delete'
              ? 'Deleted'
              : 'Updated';
      return { ok: true, value: `${verb} team memory: ${fileKey}` };
    },
  };
}

// ---------------------------------------------------------------------------
// team_memory_search
// ---------------------------------------------------------------------------

export function createTeamMemorySearchTool(teamMemory: MemoryProvider): Tool {
  return {
    name: 'team_memory_search',
    description: 'Search team memory topics by keyword. Returns matching topic files.',
    toolset: 'team_memory',
    maxResultChars: 10_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum number of results (default 5)' },
        mode: {
          type: 'string',
          enum: ['keyword', 'semantic', 'hybrid'],
          description: 'Search mode (default: keyword)',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { query, limit, mode } = args as {
        query: string;
        limit?: number;
        mode?: 'keyword' | 'semantic' | 'hybrid';
      };
      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };
      if (!ctx.teamId)
        return { ok: false, error: 'no team context for this session', code: 'not_available' };

      const memCtx = buildTeamMemoryContext(ctx, ctx.teamId);
      const results = await teamMemory.search(query, memCtx, {
        limit: Math.min(limit ?? 5, 20),
        mode,
      });

      if (results.length === 0) return { ok: true, value: `No team memory matches "${query}"` };

      const formatted = results
        .map((r) => `### ${r.key}\n\n${redactString(r.content.trim())}`)
        .join('\n\n---\n\n');
      return {
        ok: true,
        value: `${results.length} team memory match${results.length === 1 ? '' : 'es'} for "${query}":\n\n${formatted}`,
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

export function createTeamMemoryTools(teamMemory: MemoryProvider): Tool[] {
  return [
    createTeamMemoryReadTool(teamMemory),
    createTeamMemoryWriteTool(teamMemory),
    createTeamMemorySearchTool(teamMemory),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMemoryContext(ctx: ToolContext): MemoryContext {
  return {
    scopeId: ctx.memoryScopeId ?? 'global',
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir,
  };
}

function buildTeamMemoryContext(ctx: ToolContext, teamId: string): MemoryContext {
  return {
    scopeId: `team:${teamId}`,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir,
  };
}

/**
 * Validate a topic key supplied by the model. Accepts alphanumeric, hyphens,
 * and underscores — with an optional `.md` suffix. Rejects path separators,
 * traversal sequences, control characters, and any multi-component paths.
 */
export function isSafeTopicKey(key: string): boolean {
  const stripped = key.endsWith('.md') ? key.slice(0, -3) : key;
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(stripped);
}
