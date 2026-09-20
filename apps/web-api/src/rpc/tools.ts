import { describeTool, groupFor, runToolTest } from '../services/tool-inspection';
import { os } from './context';

// Thin RPC shells for the tools namespace. `approve` / `deny` resolve a
// pending approval registered by the web `before_tool_call` hook; the
// actual state machine + allowlist work lives in `ApprovalsService`.
//
// `clientId` flows in as `decidedBy` on the resulting `approval.resolved`
// SSE event so other tabs viewing the same session can auto-dismiss the
// modal with "approved by another window." — for a COOKIE caller only: a
// bearer caller's identity is the API key, not a client-supplied string
// (S9, `decidedByFor` below).
//
// `listPending` is the foreground catch-up (S3): a client that missed the
// `pending` SSE event reads the current queue instead.
//
// `catalog` / `detail` / `test` back the Personality Edit modal's toolset
// picker: what tools exist, what one of them actually is, and whether it works
// in this deployment. The detail mapping and the execution safety gate live in
// `services/tool-inspection`.

/** `human:key:<name>` when the request authenticated by bearer (S9) — the
 *  API-key row IS the identity, so a phone cannot claim to be anything by
 *  sending a different `clientId`. Cookie requests keep today's behavior:
 *  `clientId` is a tab label the client picked, recorded verbatim. Same
 *  `_authMethod`/`_apiKey` read as `rpc/kanban.ts`. */
function decidedByFor(context: object, clientId: string): string {
  const c = context as { _authMethod?: unknown; _apiKey?: { name?: unknown } };
  if (c._authMethod === 'bearer' && typeof c._apiKey?.name === 'string') {
    return `human:key:${c._apiKey.name}`;
  }
  return clientId;
}

export const toolsRouter = {
  approve: os.tools.approve.handler(async ({ input, context }) => {
    await context.approvals.approve(
      input.approvalId,
      input.scope,
      decidedByFor(context, input.clientId),
    );
    return { ok: true as const };
  }),

  deny: os.tools.deny.handler(async ({ input, context }) => {
    await context.approvals.deny(
      input.approvalId,
      input.reason,
      decidedByFor(context, input.clientId),
    );
    return { ok: true as const };
  }),

  listPending: os.tools.listPending.handler(async ({ input, context }) => {
    return context.approvals.listPending(input.sessionId);
  }),

  catalog: os.tools.catalog.handler(async ({ context }) => {
    const tools = context.toolRegistry?.getAvailable() ?? [];
    const groupMap = new Map<string, Array<{ name: string; description?: string }>>();
    for (const t of tools) {
      // MCP tools are gated by `personality.mcp_servers` (the server allowlist),
      // not by `toolset`. They have a dedicated UI (the MCP tab); excluding them
      // here keeps the built-in toolset picker to built-in tools only.
      if (t.toolset === 'mcp') continue;
      const group = groupFor(t.toolset);
      let arr = groupMap.get(group);
      if (!arr) {
        arr = [];
        groupMap.set(group, arr);
      }
      arr.push({ name: t.name, ...(t.description ? { description: t.description } : {}) });
    }
    const groups = [...groupMap.entries()].map(([group, tools]) => ({ group, tools }));
    return { groups };
  }),

  detail: os.tools.detail.handler(async ({ input, context }) => {
    const personality =
      input.personalityId === undefined
        ? undefined
        : (await context.personalities.get(input.personalityId)).personality;
    return describeTool(context.toolRegistry, input.name, personality);
  }),

  test: os.tools.test.handler(async ({ input, context }) => {
    const { personality } = await context.personalities.get(input.personalityId);
    return runToolTest(context.toolRegistry, input.name, personality, input.mode);
  }),
};
