import { os } from './context';

// Thin RPC shells for the tools namespace. Both procedures resolve a
// pending approval registered by the web `before_tool_call` hook; the
// actual state machine + allowlist work lives in `ApprovalsService`.
//
// `clientId` flows in as `decidedBy` on the resulting `approval.resolved`
// SSE event so other tabs viewing the same session can auto-dismiss the
// modal with "approved by another window."

export const toolsRouter = {
  approve: os.tools.approve.handler(async ({ input, context }) => {
    await context.approvals.approve(input.approvalId, input.scope, input.clientId);
    return { ok: true as const };
  }),

  deny: os.tools.deny.handler(async ({ input, context }) => {
    await context.approvals.deny(input.approvalId, input.reason, input.clientId);
    return { ok: true as const };
  }),

  catalog: os.tools.catalog.handler(async ({ context }) => {
    const tools = context.toolRegistry?.getAvailable() ?? [];
    const groupMap = new Map<string, Array<{ name: string; description?: string }>>();
    for (const t of tools) {
      // MCP tools are gated by `personality.mcp_servers` (the server allowlist),
      // not by `toolset`. They have a dedicated UI (the MCP tab); excluding them
      // here keeps the built-in toolset picker to built-in tools only.
      if (t.toolset === 'mcp') continue;
      const group = t.toolset ? t.toolset.charAt(0).toUpperCase() + t.toolset.slice(1) : 'Other';
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
};
