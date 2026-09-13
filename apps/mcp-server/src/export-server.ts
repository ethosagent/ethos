// `PersonalityExportServer` — ONE personality, published to ONE external MCP
// client, bounded by that personality's own `mcp_export` declaration.
// Part 3 of plan/phases/trust-before-reach.md (M-T5, M-T6).
//
// This is deliberately NOT a mode of `EthosMcpServer` (M-D1). That one is the
// operator console: full trust, every personality, every session on the
// machine, installed on purpose (M-D14). A mode flag inside its
// `_registerHandlers` would make every tool added there a potential export
// leak forever after. A separate class exposes exactly what it registers and
// nothing else, and what it registers is one tool.
//
// The four things a client of this server can never do:
//
//  1. Name the personality. `personalityId` is pinned at construction; there is
//     no `personality_id` parameter anywhere in the schema (M-D12).
//  2. Name the session key. The server builds `mcp:<id>:<clientId>:<conversation>`
//     and the `conversation` regex is what stops a client writing a `:` to
//     escape its own prefix (M-D8).
//  3. Name the tool set. `toolsetNarrow`/`toolsetExclude`/`skipMemoryPrefetch`
//     all come from the resolved scope, recomputed per call.
//  4. Call a tool directly. `ask` runs a whole `loop.run(...)` turn (M-D2) —
//     `ToolRegistry.executeParallel` on its own would skip the
//     `before_tool_call` hooks (approval, terminal guard), the watcher and
//     result-defense sentinels, the injection prelude, `budgetCapUsd` and the
//     turn trace; and a full turn is the only way SOUL and `fs_reach` apply.
//     `expose_tools` names the tools that turn MAY USE. They are never
//     published as MCP tools.
//
// Everything the gate reads is re-read on every call — the personality (via
// `refreshPersonalities`), the scope (via `resolveScope`), the client's key
// (via the authenticator). That is what makes `enabled: false` and a revoked
// key take effect on the caller's NEXT CALL rather than at the next restart.
//
// Layer note: the scope resolver and the authenticator are INJECTED rather than
// imported. `resolveMcpExportScope` and `createMcpClientAuthenticator` live in
// `packages/wiring`, whose runtime graph is the whole composition chain; this
// app takes their TYPES only, and the composition root (`ethos mcp serve`,
// M-T7) hands the functions in. It also means `__tests__/export-server.test.ts`
// drives this real class with a stub loop and no composition chain at all.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AgentLoop } from '@ethosagent/core';
import type { PersonalityConfig, SessionStore } from '@ethosagent/types';
import type { McpClientAuthenticator, McpExportScope, McpExportToolView } from '@ethosagent/wiring';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type McpHttpHandle, serveMcpHttp } from './http-session';
import type { McpLogger } from './logger';
import { collectTurnResult } from './turn-result';

/** A client-chosen conversation LABEL, never a session key. See M-D8. */
const CONVERSATION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Audit (metadata only)
// ---------------------------------------------------------------------------

/** Which export surface produced the entry — maps to `mcp.export.<kind>`. */
export type McpExportAuditKind = 'auth' | 'discovery' | 'call';

/**
 * One audit record. Metadata ONLY, by construction: every field is an
 * identifier, a short decision label or a timestamp, and there is deliberately
 * no field for a prompt, an answer, a tool argument or a key. Adding one would
 * be a schema change here, not a value passed at a call site.
 *
 * The transcript is not missing — it lives in `sessions.db` under `sessionKey`
 * with `platform = 'mcp'`, on the session store's own retention. Putting
 * bodies here would put an external party's conversation under a telemetry
 * retention window instead. Same shape and same reasoning as `A2aAuditEntry`
 * (`packages/a2a/src/audit.ts`).
 */
export interface McpExportAuditEntry {
  kind: McpExportAuditKind;
  /** The wire event: 'initialize' | 'tools/list' | 'ask' | 'get_conversation' … */
  event: string;
  personalityId: string;
  /** `key-<prefix>` under bearer, `stdio-<name>` under localhost, `-` when unknown. */
  clientId: string;
  sessionKey?: string;
  /** The turn's trace id, from `run_start` — joins this row to `observability.db`. */
  traceId?: string;
  decision: 'accepted' | 'denied';
  /** A short reason CODE (`export_disabled`, `invalid_key`, …) — never a body. */
  reason?: string;
  severity?: 'info' | 'warn' | 'error';
  ts: number;
}

/** The injected sink. `record` is fire-and-forget — see {@link safeExportAudit}. */
export interface McpExportAuditSink {
  record(entry: McpExportAuditEntry): void;
}

/**
 * Record fail-open: a missing sink is a no-op and a throwing sink never changes
 * the outcome of the call it observes. Every audit call site funnels here — the
 * same contract as `safeAudit` in `packages/a2a/src/audit.ts`.
 */
export function safeExportAudit(
  sink: McpExportAuditSink | undefined,
  entry: McpExportAuditEntry,
): void {
  if (!sink) return;
  try {
    sink.record(entry);
  } catch {
    // fail-open — audit must never break the exchange it observes.
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The one registry method this server needs. `PersonalityRegistry` satisfies it. */
export interface ExportPersonalityView {
  get(id: string): PersonalityConfig | undefined;
}

export interface PersonalityExportServerConfig {
  /** The ONE personality this server exports. Pinned; never client-supplied. */
  personalityId: string;
  loop: AgentLoop;
  /**
   * THIS loop's personality registry (`CreateAgentLoopResult.personalities`) —
   * the one the turn will run against. A second `FilePersonalityRegistry` would
   * carry a second mtime cache and could answer differently.
   */
  personalities: ExportPersonalityView;
  /** `CreateAgentLoopResult.refreshPersonalities` — run before every gate. */
  refreshPersonalities: () => Promise<void>;
  /** The loop's `DefaultToolRegistry`, read live so a late MCP tool is excluded. */
  toolRegistry: McpExportToolView;
  /** `resolveMcpExportScope` from `@ethosagent/wiring`. Injected — see the header. */
  resolveScope: (personality: PersonalityConfig, registry: McpExportToolView) => McpExportScope;
  logger: McpLogger;
  version?: string;
  /**
   * Required when the resolved `auth` is `'bearer'`; unused under `'localhost'`.
   * `createMcpClientAuthenticator` from `@ethosagent/wiring`.
   */
  authenticator?: McpClientAuthenticator;
  /**
   * The secret a STDIO client presented, from `ETHOS_MCP_KEY` in its MCP entry.
   * Only read when the resolved `auth` is `'bearer'`. HTTP reads the
   * `Authorization` header per request instead.
   */
  stdioSecret?: string;
  /** Absent → `list_conversations`/`get_conversation` are never offered. */
  sessionStore?: SessionStore;
  audit?: McpExportAuditSink;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** What one accepted gate resolved to. */
interface GateOk {
  ok: true;
  personality: PersonalityConfig;
  scope: McpExportScope;
  clientId: string;
}

interface GateDenied {
  ok: false;
  /**
   * Which audit category the refusal belongs to — decided HERE, where the
   * reason code is produced, so a new reason cannot be silently mis-filed by a
   * call site guessing from the string.
   */
  kind: 'auth' | 'call';
  /** Short code for the audit row AND the caller's error text. */
  reason: string;
  message: string;
}

type Gate = GateOk | GateDenied;

/** Per-CONNECTION facts. One per stdio process, one per HTTP session. */
interface ConnectionContext {
  /** The bearer secret this connection presented, if any. */
  secret?: string;
}

/**
 * `stdio-<sanitized clientInfo.name>` (M-D8). The sanitizer's job is narrow and
 * load-bearing: the result becomes a segment of a session key, so it must not
 * contain a `:`. Two stdio clients that self-report the same name share a
 * prefix; accepted as a limitation, since under `localhost` both already run as
 * the same OS user and the trust boundary is "who can spawn `ethos`".
 */
export function stdioClientId(name: string | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `stdio-${cleaned === '' ? 'unknown' : cleaned}`;
}

/** `mcp:<personalityId>:<clientId>:<conversation>` (M-D8). Never client-supplied. */
export function exportSessionKey(
  personalityId: string,
  clientId: string,
  conversation: string,
): string {
  return `${exportSessionKeyPrefix(personalityId, clientId)}${conversation}`;
}

/**
 * `mcp:<personalityId>:<clientId>:` — what the conversation tools filter on, so
 * they see only THIS client's conversations with THIS personality (M-D7). An
 * operator's own `cli:` or `mcp-console:` sessions with the same personality
 * are outside the prefix and stay private.
 */
export function exportSessionKeyPrefix(personalityId: string, clientId: string): string {
  return `mcp:${personalityId}:${clientId}:`;
}

const textResult = (text: string): { content: Array<{ type: 'text'; text: string }> } => ({
  content: [{ type: 'text' as const, text }],
});

const errorResult = (
  code: string,
  message: string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
  content: [{ type: 'text' as const, text: `${code}: ${message}` }],
  isError: true,
});

/** Read `Authorization: Bearer <secret>`. Case-insensitive scheme, per RFC 7235. */
function bearerSecret(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export class PersonalityExportServer {
  readonly personalityId: string;

  private readonly _config: PersonalityExportServerConfig;
  /** At most one `ask` in flight per client (M-T5, "Result mapping"). */
  private readonly _inFlight = new Set<string>();
  /** HTTP session id → the key id that opened it (M-T6). */
  private readonly _sessionKeyIds = new Map<string, string>();
  /** Per-request verified identity, so `serverFactory` need not verify twice. */
  private readonly _verified = new WeakMap<IncomingMessage, { keyId: string }>();
  private _stdio: Server | null = null;
  private _http: McpHttpHandle | null = null;
  private readonly _httpServers = new Set<Server>();

  constructor(config: PersonalityExportServerConfig) {
    this._config = config;
    this.personalityId = config.personalityId;
  }

  // -------------------------------------------------------------------------
  // The per-call gate
  // -------------------------------------------------------------------------

  /**
   * The three checks every single call runs, in this order:
   *
   *   1. `refreshPersonalities()`, then re-read the personality — a directory
   *      edited or deleted while the process lives is seen now, not at restart.
   *   2. Re-resolve the scope and require `enabled === true` (M-D4). Setting
   *      `mcp_export.enabled: false` withdraws the export on the next call.
   *   3. Re-verify the client's key (bearer) or derive its stdio identity.
   *      Revoking one client's key locks out that client and no one else.
   *
   * Steps 1–2 are one `resolveScope` call: the enabled flag IS part of the
   * resolution, and resolving twice to check it separately would be two answers
   * where there is one.
   */
  private async _gate(ctx: ConnectionContext, server: Server): Promise<Gate> {
    const { personalityId, personalities, refreshPersonalities, resolveScope, toolRegistry } =
      this._config;

    try {
      await refreshPersonalities();
    } catch (err) {
      // A failed reload must not silently serve a stale declaration.
      this._config.logger.warn('mcp_export_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        kind: 'call',
        reason: 'refresh_failed',
        message: 'the personality registry could not be re-read; refusing to serve a stale export',
      };
    }

    const personality = personalities.get(personalityId);
    if (!personality) {
      return {
        ok: false,
        kind: 'call',
        reason: 'unknown_personality',
        message: `personality "${personalityId}" is no longer present`,
      };
    }

    const scope = resolveScope(personality, toolRegistry);
    if (!scope.enabled) {
      return {
        ok: false,
        kind: 'call',
        reason: 'export_disabled',
        message: `personality "${personalityId}" is not exported over MCP`,
      };
    }

    if (scope.auth === 'bearer') {
      const authenticator = this._config.authenticator;
      if (!authenticator) {
        return {
          ok: false,
          kind: 'auth',
          reason: 'authenticator_unavailable',
          message: 'this export requires a bearer key but no key store is wired',
        };
      }
      const verdict = await authenticator.verify(ctx.secret);
      if (!verdict.ok) {
        return {
          ok: false,
          kind: 'auth',
          reason: verdict.reason,
          message: `a valid key with scope ${authenticator.requiredScope} is required`,
        };
      }
      return { ok: true, personality, scope, clientId: verdict.clientId };
    }

    return {
      ok: true,
      personality,
      scope,
      clientId: stdioClientId(server.getClientVersion()?.name),
    };
  }

  private _audit(entry: Omit<McpExportAuditEntry, 'personalityId' | 'ts'>): void {
    safeExportAudit(this._config.audit, {
      ...entry,
      personalityId: this._config.personalityId,
      ts: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Tool definitions
  // -------------------------------------------------------------------------

  /**
   * `ask` is described by the PERSONALITY's own description, not by a generic
   * blurb (M-D12): the calling model chooses the tool from this string, so it
   * is the personality's one chance to say what it is for.
   */
  private _askToolDef(personality: PersonalityConfig): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  } {
    const description =
      personality.description?.trim() ||
      `Ask ${personality.name}, an Ethos personality, and receive its reply.`;
    return {
      name: 'ask',
      description,
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: `The message to send to ${personality.name}.` },
          conversation: {
            type: 'string',
            description:
              'Optional conversation id returned by a previous call, to continue it. Letters, digits, hyphen and underscore, 1-64 characters. Omit to start a fresh conversation and receive a generated id.',
            pattern: CONVERSATION_PATTERN.source,
          },
        },
        required: ['prompt'],
      },
    };
  }

  private _conversationToolDefs(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: 'list_conversations',
        description:
          'List your own previous conversations with this personality, most recently updated first. Only conversations you started through this server are visible.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            limit: { type: 'number', description: 'Maximum conversations to return (default 20).' },
          },
        },
      },
      {
        name: 'get_conversation',
        description:
          'Read back the messages of one of your own conversations with this personality.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            conversation: {
              type: 'string',
              description: 'The conversation id, as returned by `ask` or `list_conversations`.',
              pattern: CONVERSATION_PATTERN.source,
            },
            limit: { type: 'number', description: 'Maximum messages to return (default 50).' },
          },
          required: ['conversation'],
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async _handleAsk(
    gate: GateOk,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const { clientId, scope } = gate;

    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (prompt.trim() === '') {
      this._audit({
        kind: 'call',
        event: 'ask',
        clientId,
        decision: 'denied',
        reason: 'input_invalid',
        severity: 'warn',
      });
      return errorResult('input_invalid', 'prompt is required');
    }

    const raw = args.conversation;
    if (raw !== undefined && typeof raw !== 'string') {
      this._audit({
        kind: 'call',
        event: 'ask',
        clientId,
        decision: 'denied',
        reason: 'input_invalid',
        severity: 'warn',
      });
      return errorResult('input_invalid', 'conversation must be a string');
    }
    const conversation = raw ?? randomUUID();
    if (!CONVERSATION_PATTERN.test(conversation)) {
      this._audit({
        kind: 'call',
        event: 'ask',
        clientId,
        decision: 'denied',
        reason: 'input_invalid',
        severity: 'warn',
      });
      return errorResult(
        'input_invalid',
        `conversation must match ${CONVERSATION_PATTERN.source} (got ${JSON.stringify(conversation)})`,
      );
    }

    // One turn at a time per client. Not a rate limit (M-D15 records that there
    // is none) — it keeps one client from fanning out N concurrent paid turns
    // against the same key while its budget cap is evaluated per session.
    if (this._inFlight.has(clientId)) {
      this._audit({
        kind: 'call',
        event: 'ask',
        clientId,
        decision: 'denied',
        reason: 'busy',
        severity: 'warn',
      });
      return errorResult('busy', 'a previous ask from this client is still running');
    }

    const sessionKey = exportSessionKey(this._config.personalityId, clientId, conversation);
    this._inFlight.add(clientId);
    let turn: Awaited<ReturnType<typeof collectTurnResult>>;
    try {
      turn = await collectTurnResult(
        this._config.loop.run(prompt, {
          // Pinned by the SERVER, every one of them. None is reachable from the
          // tool's input schema.
          sessionKey,
          personalityId: this._config.personalityId,
          toolsetNarrow: scope.allowed,
          // The load-bearing half: narrow gates built-ins only, so without this
          // an `expose_tools: none` specialist could still call every MCP,
          // plugin and `alwaysInclude` tool on the machine (M-D3).
          toolsetExclude: scope.exclude,
          ...(scope.memory === 'none' ? { skipMemoryPrefetch: true } : {}),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._audit({
        kind: 'call',
        event: 'ask',
        clientId,
        sessionKey,
        decision: 'denied',
        reason: 'turn_threw',
        severity: 'error',
      });
      return errorResult('turn_failed', message);
    } finally {
      this._inFlight.delete(clientId);
    }

    // The conversation id rides along so the client can continue without ever
    // naming a session key.
    const handle = { type: 'text' as const, text: JSON.stringify({ conversation }) };

    if (turn.error) {
      this._audit({
        kind: 'call',
        event: 'ask',
        clientId,
        sessionKey,
        ...(turn.traceId ? { traceId: turn.traceId } : {}),
        decision: 'denied',
        reason: turn.error.code,
        severity: 'warn',
      });
      return {
        content: [
          { type: 'text' as const, text: `${turn.error.code}: ${turn.error.message}` },
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          handle,
        ],
        isError: true,
      };
    }

    this._audit({
      kind: 'call',
      event: 'ask',
      clientId,
      sessionKey,
      ...(turn.traceId ? { traceId: turn.traceId } : {}),
      decision: 'accepted',
    });
    return { content: [{ type: 'text' as const, text: turn.text }, handle] };
  }

  private async _handleListConversations(
    gate: GateOk,
    args: Record<string, unknown>,
    store: SessionStore,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const prefix = exportSessionKeyPrefix(this._config.personalityId, gate.clientId);
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
    const sessions = await store.listSessions({ keyPrefix: prefix, limit });
    const rows = sessions.map((s) => ({
      conversation: s.key.slice(prefix.length),
      title: s.title ?? null,
      updatedAt: s.updatedAt.toISOString(),
    }));
    this._audit({
      kind: 'call',
      event: 'list_conversations',
      clientId: gate.clientId,
      decision: 'accepted',
    });
    return textResult(JSON.stringify(rows, null, 2));
  }

  private async _handleGetConversation(
    gate: GateOk,
    args: Record<string, unknown>,
    store: SessionStore,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const conversation = typeof args.conversation === 'string' ? args.conversation : '';
    if (!CONVERSATION_PATTERN.test(conversation)) {
      this._audit({
        kind: 'call',
        event: 'get_conversation',
        clientId: gate.clientId,
        decision: 'denied',
        reason: 'input_invalid',
        severity: 'warn',
      });
      return errorResult('input_invalid', `conversation must match ${CONVERSATION_PATTERN.source}`);
    }
    // The key is BUILT from the caller's own prefix, so there is no reachable
    // input that names another client's — or the operator's — session (M-D7).
    const sessionKey = exportSessionKey(this._config.personalityId, gate.clientId, conversation);
    const session = await store.getSessionByKey(sessionKey);
    if (!session) {
      this._audit({
        kind: 'call',
        event: 'get_conversation',
        clientId: gate.clientId,
        sessionKey,
        decision: 'denied',
        reason: 'not_found',
        severity: 'warn',
      });
      return errorResult('not_found', `no conversation "${conversation}"`);
    }
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50;
    const messages = await store.getMessages(session.id, { limit });
    this._audit({
      kind: 'call',
      event: 'get_conversation',
      clientId: gate.clientId,
      sessionKey,
      decision: 'accepted',
    });
    return textResult(
      JSON.stringify(
        {
          conversation,
          title: session.title ?? null,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp.toISOString(),
          })),
        },
        null,
        2,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Server construction
  // -------------------------------------------------------------------------

  /**
   * Build one MCP `Server` for one connection.
   *
   * One per transport session, never shared: SDK 1.29.0's `Protocol.connect`
   * throws `Already connected to a transport` on a second call
   * (`http-session.ts`).
   *
   * Capabilities are `{ tools: {} }` and nothing else — no resources, no
   * prompts. Memory is reachable only as a tool the turn may use, never
   * published as a readable resource (M-D5).
   */
  private async _createServer(ctx: ConnectionContext): Promise<Server> {
    const { personalityId, personalities, refreshPersonalities, version } = this._config;
    // Best-effort: the identity strings below are discovery text, and a failed
    // refresh must not stop a connection the gate will refuse anyway.
    await refreshPersonalities().catch(() => {});
    const personality = personalities.get(personalityId);

    const server = new Server(
      { name: `ethos-${personalityId}`, version: version ?? 'dev' },
      {
        capabilities: { tools: {} },
        instructions: personality
          ? `${personality.name}${personality.description ? ` — ${personality.description}` : ''}`
          : `Ethos personality "${personalityId}".`,
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const gate = await this._gate(ctx, server);
      if (!gate.ok) {
        this._audit({
          kind: 'discovery',
          event: 'tools/list',
          clientId: '-',
          decision: 'denied',
          reason: gate.reason,
          severity: 'warn',
        });
        // Default-deny: a withdrawn export publishes nothing, rather than
        // advertising a tool whose every call would be refused.
        return { tools: [] };
      }
      const tools = [this._askToolDef(gate.personality)];
      if (gate.scope.sessions && this._config.sessionStore) {
        tools.push(...this._conversationToolDefs());
      }
      this._audit({
        kind: 'discovery',
        event: 'tools/list',
        clientId: gate.clientId,
        decision: 'accepted',
      });
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const safeArgs = (args ?? {}) as Record<string, unknown>;

      // Deliberately no `args` in the log line: an exported prompt is another
      // party's content and this process writes its logs to stderr.
      this._config.logger.info('mcp_export_tool_call', { personalityId, tool: name });

      try {
        const gate = await this._gate(ctx, server);
        if (!gate.ok) {
          this._audit({
            kind: gate.kind,
            event: name,
            clientId: '-',
            decision: 'denied',
            reason: gate.reason,
            severity: 'warn',
          });
          return errorResult(gate.reason, gate.message);
        }

        if (name === 'ask') return await this._handleAsk(gate, safeArgs);

        const store = this._config.sessionStore;
        if ((name === 'list_conversations' || name === 'get_conversation') && gate.scope.sessions) {
          if (!store) return errorResult('not_available', 'conversations are not available');
          return name === 'list_conversations'
            ? await this._handleListConversations(gate, safeArgs, store)
            : await this._handleGetConversation(gate, safeArgs, store);
        }

        this._audit({
          kind: 'call',
          event: name,
          clientId: gate.clientId,
          decision: 'denied',
          reason: 'unknown_tool',
          severity: 'warn',
        });
        return errorResult('unknown_tool', `this server exposes no tool named "${name}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this._config.logger.error('mcp_export_tool_error', { tool: name, error: message });
        return errorResult('internal_error', message);
      }
    });

    server.oninitialized = () => {
      void this._gate(ctx, server).then((gate) => {
        this._audit({
          kind: 'auth',
          event: 'initialize',
          clientId: gate.ok ? gate.clientId : '-',
          decision: gate.ok ? 'accepted' : 'denied',
          ...(gate.ok ? {} : { reason: gate.reason, severity: 'warn' as const }),
        });
      });
    };

    return server;
  }

  // -------------------------------------------------------------------------
  // Transports
  // -------------------------------------------------------------------------

  /**
   * Attach one freshly built `Server` to a transport the caller owns, as the
   * single connection of a `localhost`-style export.
   *
   * `start()` is this with a `StdioServerTransport`. It is separate so a caller
   * that already has a transport — the SDK's `InMemoryTransport`, which every
   * test below uses — drives the REAL handlers rather than a re-implementation
   * of them. `secret` is what the connection presented (`ETHOS_MCP_KEY` for
   * stdio); leave it unset for a `localhost` export, which reads none.
   */
  async connect(transport: Transport, opts: { secret?: string } = {}): Promise<void> {
    const secret = opts.secret ?? this._config.stdioSecret;
    const server = await this._createServer({ ...(secret ? { secret } : {}) });
    this._stdio = server;
    await server.connect(transport);
  }

  /** stdio. The only transport an `auth: 'localhost'` export has (M-D15). */
  async start(): Promise<void> {
    await this.connect(new StdioServerTransport());
    this._config.logger.info('mcp_export_started', {
      transport: 'stdio',
      personalityId: this._config.personalityId,
    });
  }

  /**
   * Streamable HTTP, on B-T3's per-session helper (M-T6).
   *
   * Three things hold here that do not hold for the operator console's
   * `serveHttp`:
   *
   *  - **`auth: 'bearer'` is required.** An `auth: 'localhost'` export refuses
   *    to serve HTTP at all, and throws here rather than binding a port: the
   *    localhost trust boundary is "whoever can spawn `ethos` as this OS user",
   *    and a listening socket is not that boundary even on loopback — any page
   *    the user visits can POST to it.
   *  - **The key is verified on EVERY request**, not only at `initialize`. An
   *    MCP session outlives a single request by design; without a per-request
   *    check a revoked key would keep working until the client disconnected.
   *  - **Each session id is bound to the key id that opened it**, so a second
   *    key cannot resume someone else's session by quoting its id.
   *
   * Loopback-only binding and DNS-rebinding protection come from the helper.
   */
  async serveHttp(opts: { port: number; host?: string }): Promise<McpHttpHandle> {
    const { personalityId, personalities, refreshPersonalities, resolveScope, toolRegistry } =
      this._config;
    await refreshPersonalities();
    const personality = personalities.get(personalityId);
    if (!personality) {
      throw new Error(`personality "${personalityId}" is not present`);
    }
    const scope = resolveScope(personality, toolRegistry);
    if (!scope.enabled) {
      throw new Error(`personality "${personalityId}" is not exported over MCP`);
    }
    if (scope.auth !== 'bearer') {
      throw new Error(
        `personality "${personalityId}" declares mcp_export.auth: localhost, which is stdio only. Set auth: bearer to serve it over HTTP.`,
      );
    }
    const authenticator = this._config.authenticator;
    if (!authenticator) {
      throw new Error('a bearer export needs an authenticator; none was wired');
    }

    const handle = await serveMcpHttp({
      port: opts.port,
      ...(opts.host ? { host: opts.host } : {}),
      logger: this._config.logger,
      authorize: async ({ req, sessionId }) => {
        const verdict = await authenticator.verify(bearerSecret(req));
        if (!verdict.ok) {
          this._audit({
            kind: 'auth',
            event: 'http-request',
            clientId: '-',
            decision: 'denied',
            reason: verdict.reason,
            severity: 'warn',
          });
          return {
            ok: false,
            status: 401,
            message: `unauthorized: a valid key with scope ${authenticator.requiredScope} is required`,
          };
        }
        if (sessionId !== undefined) {
          const bound = this._sessionKeyIds.get(sessionId);
          // An unknown session id is left to the transport, which answers with
          // its own "no such session" — only a MISMATCH is this layer's call.
          if (bound !== undefined && bound !== verdict.keyId) {
            this._audit({
              kind: 'auth',
              event: 'http-request',
              clientId: verdict.clientId,
              decision: 'denied',
              reason: 'session_key_mismatch',
              severity: 'warn',
            });
            return { ok: false, status: 403, message: 'forbidden: session belongs to another key' };
          }
        } else {
          this._audit({
            kind: 'auth',
            event: 'http-request',
            clientId: verdict.clientId,
            decision: 'accepted',
          });
        }
        this._verified.set(req, { keyId: verdict.keyId });
        return { ok: true };
      },
      onSessionOpened: (id, req) => {
        const verified = this._verified.get(req);
        if (verified) this._sessionKeyIds.set(id, verified.keyId);
      },
      onSessionClosed: (id) => {
        this._sessionKeyIds.delete(id);
      },
      serverFactory: async (ctx) => {
        const server = await this._createServer({
          ...(ctx ? { secret: bearerSecret(ctx.req) } : {}),
        });
        this._httpServers.add(server);
        server.onclose = () => this._httpServers.delete(server);
        return server;
      },
    });
    this._http = handle;
    return handle;
  }

  /** Idempotent. Closes the HTTP listener and every live server. */
  async close(): Promise<void> {
    if (this._http) {
      await this._http.close();
      this._http = null;
    }
    for (const server of [...this._httpServers]) {
      await server.close().catch(() => {});
    }
    this._httpServers.clear();
    this._sessionKeyIds.clear();
    if (this._stdio) {
      await this._stdio.close().catch(() => {});
      this._stdio = null;
    }
  }
}
