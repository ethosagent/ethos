// The composition-root pieces of `ethos mcp serve --personality <id>` and
// `ethos mcp install <client> --personality <id>` (M-T7,
// plan/phases/trust-before-reach.md Part 3).
//
// Everything here is pure or takes its dependencies as arguments. The heavy
// half — building the loop, opening sessions.db, constructing the
// `PersonalityExportServer` — lives in `./mcp.ts`, which is the actual
// composition root; this module holds the decisions that file makes, so each
// can be tested without booting a runtime:
//
//   - `exportServeGate`  — M-D4, the fail-closed admission check.
//   - `resolveExportWorkingDir` — M-D11, the pinned working directory.
//   - `createExportApprovalGate` — M-D10, approval fails closed.
//   - `formatExportSummary` — the one stderr line the operator reads.
//   - `createMcpExportAuditSink` — `McpExportAuditEntry` → `mcp.export.*`.
//   - `buildExportEntry` — the `ethos-<id>` MCP client entry.
//   - `claudeDesktopExportEntry` — that entry as Claude Desktop config, for the web.

import { join } from 'node:path';
import {
  claudeDesktop,
  type McpEntry,
  type McpExportAuditEntry,
  type McpExportAuditSink,
} from '@ethosagent/mcp-server';
import type { PersonalityConfig } from '@ethosagent/types';
import type { DangerPredicate, EthosEventCategory, McpExportScope } from '@ethosagent/wiring';

// ---------------------------------------------------------------------------
// Admission (M-D4)
// ---------------------------------------------------------------------------

/** A refusal the caller turns into a JSON line on stderr plus `exit 1`. */
export interface ExportServeRefusal {
  ok: false;
  /** Short machine code — the `code` field of the stderr JSON. */
  code:
    | 'unknown_personality'
    | 'export_disabled'
    | 'http_requires_bearer'
    | 'missing_authenticator';
  message: string;
}

/**
 * An admitted export, carrying the two values the gate proved present. They are
 * returned rather than re-read at the call site so the composition root cannot
 * narrow them a second, differently.
 */
export interface ExportServeAdmission {
  ok: true;
  personality: PersonalityConfig;
  scope: McpExportScope;
}

export type ExportServeGate = ExportServeAdmission | ExportServeRefusal;

/**
 * May `ethos mcp serve --personality <id>` start at all?
 *
 * Fail-closed in both directions (M-D4): an id the registry does not know and a
 * personality whose `mcp_export.enabled` is anything other than a literal
 * `true` are BOTH refusals, not a default export. `scope.enabled` is the
 * resolver's own literal-`true` check (`resolveMcpExportScope`,
 * `packages/wiring/src/mcp-export.ts`) — this never re-reads the declaration,
 * so the two cannot drift.
 *
 * `--http` additionally requires `auth: 'bearer'`. The export server throws for
 * this case too (`PersonalityExportServer.serveHttp`); checking it HERE is what
 * turns that throw into a readable CLI refusal rather than a stack trace, and
 * the server's throw remains the enforcer for every non-CLI caller.
 */
export function exportServeGate(opts: {
  personalityId: string;
  personality: PersonalityConfig | undefined;
  scope: McpExportScope | undefined;
  http: boolean;
}): ExportServeGate {
  if (!opts.personality || !opts.scope) {
    return {
      ok: false,
      code: 'unknown_personality',
      message: `No personality "${opts.personalityId}". Run: ethos personality list`,
    };
  }
  if (!opts.scope.enabled) {
    return {
      ok: false,
      code: 'export_disabled',
      message: `Personality "${opts.personalityId}" does not declare mcp_export.enabled: true, so it is not exported over MCP.`,
    };
  }
  if (opts.http && opts.scope.auth !== 'bearer') {
    return {
      ok: false,
      code: 'http_requires_bearer',
      message: `Personality "${opts.personalityId}" declares mcp_export.auth: localhost, which is stdio only. Set auth: bearer to serve it over HTTP.`,
    };
  }
  return { ok: true, personality: opts.personality, scope: opts.scope };
}

/**
 * The stderr JSON an export refusal writes. stdout stays pure JSON-RPC even on
 * the failure path — a client that already spawned us must not be handed a
 * half-frame — so every word this command says goes to stderr.
 */
export function formatExportError(refusal: ExportServeRefusal): string {
  return `${JSON.stringify({ level: 'error', code: refusal.code, msg: refusal.message })}\n`;
}

// ---------------------------------------------------------------------------
// Pinned working directory (M-D11)
// ---------------------------------------------------------------------------

/**
 * The working directory an exported turn starts from:
 * `<dataDir>/personalities/<id>` — the personality's own directory, always, and
 * NEVER the launcher's cwd (M-D11).
 *
 * `ethos mcp serve --personality` is spawned BY the MCP client, and Claude
 * Desktop's working directory is whatever the OS handed the app — usually `/`,
 * sometimes the user's home. Letting a bare `read_file('notes.md')` resolve
 * against that is an arbitrary-directory reach nobody chose. This value is
 * passed as `CreateAgentLoopOptions.workingDir`, which is the only thing that
 * decides the reach of a personality declaring no `fs_reach.workdir`.
 *
 * A personality that DOES declare one keeps it: `deriveFsReachPaths`
 * (`packages/core/src/fs-reach.ts`, applied per turn by
 * `packages/core/src/agent-loop/stages/turn-setup.ts`) resolves
 * `fs_reach.workdir[0]` and overrides the boot-time value — which is the
 * "`fs_reach.workdir[0]`, or the personality directory when absent" half of
 * M-D11, enforced in one place for every surface rather than recomputed here.
 * The pin still matters in that case: turn-setup substitutes `${CWD}` against
 * the boot-time value, so a declared `workdir: ${CWD}/work` resolves under the
 * personality directory instead of under whatever directory the client was
 * launched from.
 */
export function resolveExportWorkingDir(opts: { personalityId: string; dataDir: string }): string {
  return join(opts.dataDir, 'personalities', opts.personalityId);
}

// ---------------------------------------------------------------------------
// Approval fails closed (M-D10)
// ---------------------------------------------------------------------------

/** What the agent is told when a dangerous call is refused over the export. */
export function exportApprovalRejection(toolName: string, reason: string): string {
  return `${toolName} requires approval; unavailable over MCP export (${reason})`;
}

/**
 * Turn the approval danger predicate into a `before_tool_call` handler that
 * REJECTS rather than prompts (M-D10).
 *
 * Every other surface that gates dangerous calls has somebody to ask: the web
 * modal, the Slack card, the terminal prompt. An MCP transport has nobody —
 * the caller is another program, and the operator may not even be at the
 * machine. The two failure modes either side of this are both wrong: prompting
 * hangs the call forever, and letting it through hands an external client the
 * tools the operator wanted to be asked about. So it is refused, and the
 * refusal text says why, so the agent can tell its caller instead of retrying.
 *
 * Under `approvalMode: 'smart'` the reviewer still runs inside the predicate:
 * a call it approves returns no reason and never reaches the rejection.
 *
 * Registering this also satisfies core's `createApprovalPostureGuard`
 * (`packages/core/src/agent-loop/approval-posture.ts`), which throws
 * `ApprovalPostureError` at the first tool dispatch when a loop declares
 * `approvalPosture: 'gated'` — as every wiring-built loop does — and nothing is
 * registered behind the `before_tool_call` fire site.
 */
export function createExportApprovalGate(
  danger: DangerPredicate,
): (payload: import('@ethosagent/types').BeforeToolCallPayload) => Promise<{ error?: string }> {
  return async (payload) => {
    const reason = await danger(payload);
    if (!reason) return {};
    return { error: exportApprovalRejection(payload.toolName, reason) };
  };
}

// ---------------------------------------------------------------------------
// The summary line
// ---------------------------------------------------------------------------

/**
 * The one line `ethos mcp serve --personality <id>` writes to stderr:
 *
 *   `exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: localhost (stdio)`
 *
 * It is the operator's only chance to see what they just published, so it
 * states the resolved scope, never the declaration: `tools:` is the
 * INTERSECTION with the personality's reach, and a named tool that fell outside
 * it gets its own `dropped:` field rather than disappearing — a silently
 * ignored line in `expose_tools` is how an operator ends up believing they
 * exported something they did not.
 */
export function formatExportSummary(personalityId: string, scope: McpExportScope): string {
  const fields = [
    `tools: ${scope.allowed.length > 0 ? scope.allowed.join(', ') : 'none'}`,
    ...(scope.dropped.length > 0 ? [`dropped: ${scope.dropped.join(', ')}`] : []),
    `memory: ${scope.memory}`,
    `conversations: ${scope.sessions ? 'on' : 'off'}`,
    `auth: ${scope.auth === 'bearer' ? 'bearer (stdio + HTTP)' : 'localhost (stdio)'}`,
  ];
  return `exporting ${personalityId} — ${fields.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Audit → observability
// ---------------------------------------------------------------------------

/** `McpExportAuditEntry.kind` → the `mcp.export.*` observability category. */
const EXPORT_AUDIT_CATEGORY: Record<McpExportAuditEntry['kind'], EthosEventCategory> = {
  auth: 'mcp.export.auth',
  discovery: 'mcp.export.discovery',
  call: 'mcp.export.call',
};

/**
 * Map the export server's metadata-only audit entries onto `recordEthosEvent`,
 * exactly the way `apps/ethos/src/commands/serve.ts` maps `A2aAuditEntry` onto
 * the `a2a.*` categories — built in the app layer so `@ethosagent/mcp-server`
 * types never leak into `packages/wiring`.
 *
 * Fail-open twice over: the `record` sink is wrapped here, and every call site
 * inside the server already goes through `safeExportAudit`. An audit row must
 * never change the outcome of the exchange it observes.
 */
export function createMcpExportAuditSink(
  record: (event: {
    category: EthosEventCategory;
    severity: 'info' | 'warn' | 'error';
    code: string;
    cause?: string;
    details: Record<string, unknown>;
  }) => void,
): McpExportAuditSink {
  return {
    record: (e: McpExportAuditEntry) => {
      try {
        record({
          category: EXPORT_AUDIT_CATEGORY[e.kind],
          severity: e.severity ?? (e.decision === 'denied' ? 'warn' : 'info'),
          code: e.event,
          ...(e.reason ? { cause: e.reason } : {}),
          details: {
            decision: e.decision,
            personalityId: e.personalityId,
            clientId: e.clientId,
            ...(e.sessionKey ? { sessionKey: e.sessionKey } : {}),
            ...(e.traceId ? { traceId: e.traceId } : {}),
          },
        });
      } catch {
        // observability unavailable — audit is fail-open (M-D15 / safeAudit).
      }
    },
  };
}

// ---------------------------------------------------------------------------
// `ethos mcp install <client> --personality <id>`
// ---------------------------------------------------------------------------

/** The MCP client entry name for one exported personality. */
export function exportEntryName(personalityId: string): string {
  return `ethos-${personalityId}`;
}

/**
 * The `ethos-<id>` entry an install writes. Named, so it lands BESIDE the
 * global `ethos` console rather than on top of it (M-D14): the two are
 * different surfaces with different trust, and a user who installed the console
 * must not silently lose it by exporting a personality.
 *
 * A bearer secret rides in `env`, never in `args` — argv is world-readable in
 * `ps` output on every platform this runs on, and the client config file is the
 * only place a long-lived secret belongs.
 */
export function buildExportEntry(opts: {
  command: string;
  scriptPath: string;
  personalityId: string;
  secret?: string;
}): McpEntry {
  return {
    name: exportEntryName(opts.personalityId),
    command: opts.command,
    args: [opts.scriptPath, 'mcp', 'serve', '--personality', opts.personalityId],
    ...(opts.secret ? { env: { ETHOS_MCP_KEY: opts.secret } } : {}),
  };
}

/**
 * The process an installed entry launches: this Node binary running this CLI
 * script. One helper for `ethos mcp install` and the web's Desktop entry, so the
 * two name the same launcher — Claude Desktop does not inherit a shell `PATH`,
 * which is why neither writes a bare `ethos`.
 */
export function exportLauncher(): { command: string; scriptPath: string } {
  return { command: process.execPath, scriptPath: process.argv[1] ?? 'ethos' };
}

/** Stands in for the client key in a Desktop entry shown before one is minted. */
export const DESKTOP_ENTRY_SECRET_PLACEHOLDER = '<client key>';

/**
 * The Claude Desktop config `ethos mcp install claude-desktop --personality <id>`
 * writes into an EMPTY config — the same `buildExportEntry`, the same
 * `claudeDesktop.injectEntry` and `serialise`, so the web's copy-ready entry
 * (M-T9) and the CLI's install cannot disagree about its shape.
 *
 * It never holds a secret. Under `bearer` the key slot carries
 * {@link DESKTOP_ENTRY_SECRET_PLACEHOLDER}; the web replaces that JSON string
 * with the secret `apiKeys.create` returned to the operator's browser.
 */
export function claudeDesktopExportEntry(opts: {
  command: string;
  scriptPath: string;
  personalityId: string;
  bearer: boolean;
}): { name: string; json: string; secretPlaceholder: string | null } {
  const entry = buildExportEntry({
    command: opts.command,
    scriptPath: opts.scriptPath,
    personalityId: opts.personalityId,
    ...(opts.bearer ? { secret: DESKTOP_ENTRY_SECRET_PLACEHOLDER } : {}),
  });
  return {
    name: exportEntryName(opts.personalityId),
    json: claudeDesktop.serialise(claudeDesktop.injectEntry({}, entry)),
    secretPlaceholder: opts.bearer ? DESKTOP_ENTRY_SECRET_PLACEHOLDER : null,
  };
}
