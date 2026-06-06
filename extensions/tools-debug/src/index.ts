import type {
  ObservabilityStore,
  SessionStore,
  StoredMessage,
  Tool,
  ToolResult,
  Trace,
} from '@ethosagent/types';

export interface DebugToolsDeps {
  sessionStore: SessionStore;
  observabilityStore?: ObservabilityStore;
  readRecentErrors?: (
    limit: number,
  ) => Array<{ ts: string; message: string; stack?: string; context?: string }>;
  checkHealth?: () => Promise<{
    ok: boolean;
    checks: Array<{ name: string; status: string; detail?: string }>;
  }>;
}

function summarizeContent(content: string, maxLen = 200): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}…`;
}

function formatMessage(msg: StoredMessage) {
  return {
    id: msg.id,
    role: msg.role,
    content: summarizeContent(msg.content),
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    toolCalls: msg.toolCalls,
    timestamp: msg.timestamp.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// get_session_events
// ---------------------------------------------------------------------------

function buildGetSessionEvents(deps: DebugToolsDeps): Tool {
  return {
    name: 'get_session_events',
    description:
      'Retrieve messages from a session for debugging. Returns role, content summary, tool calls, and timestamps.',
    toolset: 'debug',
    maxResultChars: 20_000,
    capabilities: {},
    async execute(args, _ctx): Promise<ToolResult> {
      const { sessionId, limit, eventTypes } = args as {
        sessionId: string;
        limit?: number;
        eventTypes?: string[];
      };

      if (!sessionId) {
        return { ok: false, error: 'sessionId is required', code: 'input_invalid' };
      }

      try {
        const messages = await deps.sessionStore.getMessages(sessionId, {
          limit: limit ?? 50,
        });

        const filtered = eventTypes
          ? messages.filter((m) => eventTypes.includes(m.role))
          : messages;

        return { ok: true, value: JSON.stringify(filtered.map(formatMessage), null, 2) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to inspect' },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default 50)',
        },
        eventTypes: {
          type: 'array',
          items: { type: 'string' },
          description: "Filter by message role (e.g. ['tool_result', 'assistant'])",
        },
      },
      required: ['sessionId'],
    },
  };
}

// ---------------------------------------------------------------------------
// get_observability
// ---------------------------------------------------------------------------

function getTracesBySession(store: ObservabilityStore, sessionId: string, limit: number): Trace[] {
  const recent = store.getRecentTraces(200);
  return recent.filter((t) => t.sessionId === sessionId).slice(0, limit);
}

function buildGetObservability(deps: DebugToolsDeps): Tool {
  return {
    name: 'get_observability',
    description:
      'Query observability data (traces, spans, or events) for a session. Useful for debugging performance and tool execution.',
    toolset: 'debug',
    maxResultChars: 30_000,
    capabilities: {},
    async execute(args, _ctx): Promise<ToolResult> {
      const { sessionId, kind, limit } = args as {
        sessionId: string;
        kind: 'traces' | 'spans' | 'events';
        limit?: number;
      };

      if (!sessionId) {
        return { ok: false, error: 'sessionId is required', code: 'input_invalid' };
      }
      if (!kind) {
        return { ok: false, error: 'kind is required', code: 'input_invalid' };
      }

      if (!deps.observabilityStore) {
        return {
          ok: false,
          error: 'Observability store not available',
          code: 'not_available',
        };
      }

      const store = deps.observabilityStore;
      const cap = limit ?? 50;

      try {
        if (kind === 'traces') {
          const traces = getTracesBySession(store, sessionId, cap);
          return { ok: true, value: JSON.stringify(traces, null, 2) };
        }

        const traces = getTracesBySession(store, sessionId, cap);
        const traceIds = traces.map((t) => t.traceId);

        if (kind === 'spans') {
          const spans = traceIds.flatMap((id) => store.getSpans(id));
          return { ok: true, value: JSON.stringify(spans, null, 2) };
        }

        const events = traceIds.flatMap((id) => store.getEvents({ traceId: id, limit: cap }));
        return { ok: true, value: JSON.stringify(events, null, 2) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to query' },
        kind: {
          type: 'string',
          enum: ['traces', 'spans', 'events'],
          description: 'Type of observability data to retrieve',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 50)',
        },
      },
      required: ['sessionId', 'kind'],
    },
  };
}

// ---------------------------------------------------------------------------
// get_error_log
// ---------------------------------------------------------------------------

function buildGetErrorLog(deps: DebugToolsDeps): Tool {
  return {
    name: 'get_error_log',
    description:
      'Retrieve recent errors from the error log. Useful for diagnosing crashes or unexpected failures.',
    toolset: 'debug',
    maxResultChars: 10_000,
    capabilities: {},
    async execute(args, _ctx): Promise<ToolResult> {
      if (!deps.readRecentErrors) {
        return {
          ok: false,
          error: 'Error log not available',
          code: 'not_available',
        };
      }

      const { limit } = args as { limit?: number };

      try {
        const errors = deps.readRecentErrors(limit ?? 20);
        return { ok: true, value: JSON.stringify(errors, null, 2) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
    schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of recent errors to return (default 20)',
        },
      },
      required: [],
    },
  };
}

// ---------------------------------------------------------------------------
// run_doctor
// ---------------------------------------------------------------------------

function buildRunDoctor(deps: DebugToolsDeps): Tool {
  return {
    name: 'run_doctor',
    description: 'Run a health check on the system. Returns status of all subsystem checks.',
    toolset: 'debug',
    maxResultChars: 10_000,
    capabilities: {},
    async execute(_args, _ctx): Promise<ToolResult> {
      if (!deps.checkHealth) {
        return {
          ok: false,
          error: 'Health check not available',
          code: 'not_available',
        };
      }

      try {
        const result = await deps.checkHealth();
        return { ok: true, value: JSON.stringify(result, null, 2) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildDebugTools(deps: DebugToolsDeps): Tool[] {
  return [
    buildGetSessionEvents(deps),
    buildGetObservability(deps),
    buildGetErrorLog(deps),
    buildRunDoctor(deps),
  ];
}

export { buildGetErrorLog, buildGetObservability, buildGetSessionEvents, buildRunDoctor };
