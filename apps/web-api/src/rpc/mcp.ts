import { os } from './context';

// Thin RPC shell for the MCP install-flow namespace.
//
// `_mcpPendingState` is a non-enumerable property set by the Hono layer in
// routes/rpc.ts when the `ethos_mcp_pending` cookie is present. It carries
// the cookie value into the service so complete/status can validate CSRF
// binding. The cast is intentional — modifying the oRPC context type is
// invasive, and the property is invisible to other service methods.

/** Read the pending-state cookie value threaded into context by the Hono layer. */
function pendingState(context: object): string | undefined {
  const value: unknown = (context as { _mcpPendingState?: unknown })._mcpPendingState;
  return typeof value === 'string' ? value : undefined;
}

export const mcpRouter = {
  start: os.mcp.start.handler(({ input, context }) => context.mcp.start(input)),
  complete: os.mcp.complete.handler(({ input, context }) =>
    context.mcp.complete(input, pendingState(context)),
  ),
  status: os.mcp.status.handler(({ context }) => context.mcp.status(pendingState(context))),
  cancel: os.mcp.cancel.handler(({ input, context }) => context.mcp.cancel(input.state)),
  attachPersonalities: os.mcp.attachPersonalities.handler(({ input, context }) =>
    context.mcp.attachPersonalities(input),
  ),
  list: os.mcp.list.handler(({ context }) => context.mcp.list()),
  delete: os.mcp.delete.handler(({ input, context }) => context.mcp.delete(input)),
  reconnect: os.mcp.reconnect.handler(({ input, context }) => context.mcp.reconnect(input)),
};
