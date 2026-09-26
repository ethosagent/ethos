import { applyTemporalDecay, parseTemporalBound } from '@ethosagent/core';
import { sanitize } from '@ethosagent/safety-injection';
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
      'Read the current memory files (MEMORY.md and USER.md), or pass "key" to read one arbitrary personality-scope memory entry by its exact file name. Use to recall past context, user preferences, or project notes before starting a new task.',
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
        key: {
          type: 'string',
          description:
            'Read one arbitrary personality-scope memory entry by exact key (e.g. a file written outside MEMORY.md/USER.md). When set, overrides "store".',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { store = 'both', key } = args as {
        store?: 'memory' | 'user' | 'both';
        key?: string;
      };

      if (key) {
        // Personality-scope memory files are owner-authored (same trust class as
        // MEMORY.md/USER.md below) — the trust boundary is enforced at WRITE time
        // by whoever persists the entry (e.g. wrapUntrusted() around adversarial
        // content before it's written), not here at read time. Do not add
        // outputIsUntrusted to this tool on that basis.
        const memCtx = buildMemoryContext(ctx);
        if (!memCtx) return NO_MEMORY_SCOPE;
        const entry = await memory.read(key, memCtx);
        if (!entry) {
          // 'not_found' is not a member of ToolResult's frozen error-code union
          // (packages/types/src/tool.ts) — extending that union is a Tool
          // contract change requiring two-maintainer approval + a shape-test
          // bump (ARCHITECTURE.md). 'not_available' is the closest existing
          // code and matches this file's precedent (see the "no team context"
          // checks above).
          return {
            ok: false,
            error: `no memory entry found for key "${key}"`,
            code: 'not_available',
          };
        }
        return {
          ok: true,
          value: redactString(sanitize(entry.content.trim())) || `"${key}" is empty.`,
        };
      }

      if (store === 'user') {
        const userCtx = buildUserMemoryContext(ctx);
        if (!userCtx) return NO_MEMORY_SCOPE;
        const entry = await memory.read('USER.md', userCtx);
        return {
          ok: true,
          value: redactString(sanitize(entry?.content.trim() ?? '')) || 'USER.md is empty.',
        };
      }

      const memCtx = buildMemoryContext(ctx);
      if (!memCtx) return NO_MEMORY_SCOPE;

      if (store === 'memory') {
        const entry = await memory.read('MEMORY.md', memCtx);
        return {
          ok: true,
          value: redactString(sanitize(entry?.content.trim() ?? '')) || 'MEMORY.md is empty.',
        };
      }

      // store === 'both'
      const parts: string[] = [];
      const userCtx = buildUserMemoryContext(ctx);
      if (!userCtx) return NO_MEMORY_SCOPE;
      const userEntry = await memory.read('USER.md', userCtx);
      if (userEntry?.content.trim())
        parts.push(`## About You\n\n${sanitize(userEntry.content.trim())}`);
      const memEntry = await memory.read('MEMORY.md', memCtx);
      if (memEntry?.content.trim()) parts.push(`## Memory\n\n${sanitize(memEntry.content.trim())}`);
      if (parts.length === 0) return { ok: true, value: 'Memory is empty. No notes recorded yet.' };
      return { ok: true, value: redactString(parts.join('\n\n')) };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_write
// ---------------------------------------------------------------------------

/** How much of the written content the user-facing notice quotes. */
const NOTICE_SNIPPET_CHARS = 60;

/**
 * W4 (ux-feedback-and-config-clarity) — one user-audience progress line per
 * successful write, so the person sees `remembered · "…" → USER.md` instead of
 * silence while the turn continues; a `remove` reads `forgot · …`. Emitted
 * only AFTER `memory.sync` resolved: a failed write must not claim memory.
 * The tool's return value to the LLM is unchanged.
 */
function emitMemoryNotice(
  ctx: ToolContext,
  verb: 'remembered' | 'forgot',
  content: string,
  key: string,
): void {
  const oneLine = content.trim().replace(/\s+/g, ' ');
  const snippet =
    oneLine.length > NOTICE_SNIPPET_CHARS ? `${oneLine.slice(0, NOTICE_SNIPPET_CHARS)}…` : oneLine;
  ctx.emit({
    type: 'progress',
    toolName: 'memory_write',
    audience: 'user',
    message: `${verb} · "${snippet}" → ${key}`,
  });
}

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

      const memCtx = store === 'user' ? buildUserMemoryContext(ctx) : buildMemoryContext(ctx);
      if (!memCtx) return NO_MEMORY_SCOPE;
      const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';

      if (action === 'remove') {
        const match = substring_match ?? content;
        await memory.sync([{ action: 'remove', key, substringMatch: match }], memCtx);
        emitMemoryNotice(ctx, 'forgot', match, key);
      } else {
        const sanitizedContent = sanitize(content);
        await memory.sync([{ action, key, content: sanitizedContent }], memCtx);
        emitMemoryNotice(ctx, 'remembered', content, key);
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
      "Search the current session's history using full-text search. Returns messages from this session only — it cannot reach other sessions.",
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
        since: {
          type: 'string',
          description: 'ISO-8601 date/time lower bound (inclusive), e.g. "2026-05-01"',
        },
        until: {
          type: 'string',
          description: 'ISO-8601 date/time upper bound (inclusive), e.g. "2026-05-20"',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { query, limit, since, until } = args as {
        query: string;
        limit?: number;
        since?: string;
        until?: string;
      };

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      const sinceBound = since ? parseTemporalBound(since) : undefined;
      const untilBound = until ? parseTemporalBound(until) : undefined;

      const rawResults = await session.search(query, {
        limit: Math.min(limit ?? 10, 50),
        sessionId: ctx.sessionId,
        since: sinceBound,
        until: untilBound,
      });

      const results = applyTemporalDecay(rawResults);

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
// session_list_by_date
// ---------------------------------------------------------------------------

export function createSessionListByDateTool(session: SessionStore): Tool {
  return {
    name: 'session_list_by_date',
    description:
      'List sessions filtered by date range. Returns session metadata sorted by most recent first.',
    toolset: 'memory',
    maxResultChars: 10_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO-8601 lower bound (inclusive), e.g. "2026-05-01"',
        },
        until: {
          type: 'string',
          description: 'ISO-8601 upper bound (inclusive), e.g. "2026-05-20"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (default 20)',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { since, until, limit } = args as {
        since?: string;
        until?: string;
        limit?: number;
      };

      // Scoped to the calling personality: without it the store returns every
      // personality's sessions. No personality → refuse, never list unfiltered.
      // Pinned by __tests__/session-list-scoping.test.ts.
      const personalityId = ctx.personalityId;
      if (!personalityId) {
        return {
          ok: false,
          error: 'session_list_by_date requires a personality context',
          code: 'input_invalid',
        };
      }

      const sinceBound = since ? parseTemporalBound(since) : undefined;
      const untilBound = until ? parseTemporalBound(until) : undefined;

      const sessions = await session.listSessions({
        since: sinceBound,
        limit: Math.min(limit ?? 20, 50),
        personalityId,
      });

      // Client-side filter for until (SessionFilter doesn't have until)
      const filtered = untilBound ? sessions.filter((s) => s.createdAt <= untilBound) : sessions;

      if (filtered.length === 0) {
        return { ok: true, value: 'No sessions found in the specified date range.' };
      }

      const formatted = filtered
        .map(
          (s, i) =>
            `${i + 1}. [${s.createdAt.toISOString().slice(0, 16)}] ${s.title ?? s.key} (${s.id})`,
        )
        .join('\n');

      return {
        ok: true,
        value: redactString(
          `${filtered.length} session${filtered.length === 1 ? '' : 's'}:\n\n${formatted}`,
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
      return {
        ok: true,
        value: redactString(sanitize(entry.content.trim())) || `"${key}" is empty.`,
      };
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
        const sanitizedContent = sanitize(content ?? '');
        await teamMemory.sync([{ action, key: fileKey, content: sanitizedContent }], memCtx);
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
    createSessionListByDateTool(session),
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

/**
 * Returned when a call carries no memory scope. AgentLoop stamps
 * `memoryScopeId: personality:<id>` on every tool call it makes (`memScopeId`
 * in packages/core/src/agent-loop/stages/turn-setup.ts, threaded by
 * tool-processing.ts and turn-end.ts), and the realtime voice host stamps the same
 * scope for a call with a personality (extensions/tools-voice/src/realtime-host.ts).
 * A ToolContext built outside any personality's conversation carries none — the web
 * tool-test probe (apps/web-api/src/services/tool-inspection.ts), a plugin panel
 * call (apps/web-api/src/services/plugins.service.ts). There is no shared
 * scope to fall back to: the markdown and vault backends throw on anything but
 * `personality:` / `user:` / `team:` (`resolveScopeDir`), and memory-vector would
 * file the entry under a scope no personality ever reads.
 *
 * Exported so every memory-writing tool refuses the same way — `meet_join`
 * (extensions/tools-meeting/src/index.ts) returns it too.
 */
export const NO_MEMORY_SCOPE: ToolResult = {
  ok: false,
  code: 'not_available',
  error:
    "No memory scope for this call. Memory belongs to a personality and is scoped by the agent loop (personality:<id>); this call was made outside a personality's conversation (for example a tool test or a plugin panel), so there is no memory to read or write.",
};

function buildMemoryContext(ctx: ToolContext): MemoryContext | undefined {
  if (!ctx.memoryScopeId) return undefined;
  return {
    scopeId: ctx.memoryScopeId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir,
  };
}

function buildUserMemoryContext(ctx: ToolContext): MemoryContext | undefined {
  const scopeId = ctx.userScopeId ?? ctx.memoryScopeId;
  if (!scopeId) return undefined;
  return {
    scopeId,
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
