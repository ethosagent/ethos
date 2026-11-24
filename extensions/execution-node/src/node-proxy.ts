/**
 * Server-side proxy tools for the laptop node (plan laptop-tool-node T5, D5, D12–D14).
 *
 * `node_<base>` keeps the base tool's schema (plus an optional `node`), declares no capabilities
 * (so the server resolves no scopedFs for it) and no `isAvailable` (definitions never depend on
 * connection state — prompt-prefix stability, D12). Behaviour is pinned by
 * extensions/execution-node/src/__tests__/node-proxy.test.ts.
 */
import type {
  Tool,
  ToolContext,
  ToolExecuteRequest,
  ToolProgressEvent,
  ToolResult,
} from '@ethosagent/types';
import {
  capNodeResult,
  capProgress,
  NODE_APPROVAL_TIMEOUT_MS,
  NODE_RESULT_CAP_CHARS,
  NODE_TERMINAL_MAX_MS,
} from './caps';
import { isRecord } from './frames';
import type { NodeHub } from './node-hub';
import { NodeToolTransport } from './node-tool-transport';

export const NODE_TOOL_PREFIX = 'node_';
const READ_TIMEOUT_MS = 60_000;
const TERMINAL_DEFAULT_MS = 30_000;

/** Verification D-TIMEOUT: tool time plus, where the laptop owner must approve, the approval window. */
export function nodeCallTimeoutMs(base: string, args: Record<string, unknown>): number {
  if (base === 'write_file' || base === 'patch_file')
    return READ_TIMEOUT_MS + NODE_APPROVAL_TIMEOUT_MS;
  if (base === 'terminal') {
    const asked = typeof args.timeout_ms === 'number' ? args.timeout_ms : TERMINAL_DEFAULT_MS;
    return Math.min(Math.max(asked, 1), NODE_TERMINAL_MAX_MS) + NODE_APPROVAL_TIMEOUT_MS;
  }
  return READ_TIMEOUT_MS;
}

const NODE_ARG = {
  type: 'string',
  description:
    'Node name from node_list. Optional when exactly one connected node permits this personality.',
};

function buildRequest(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolExecuteRequest {
  // Same field-by-field spread as DefaultToolRegistry's request build
  // (packages/core/src/tool-registry.ts), so the node sees what a local transport would.
  return {
    toolCallId: ctx.toolCallId ?? '',
    name,
    args,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir,
    ...(ctx.personalityId !== undefined && { personalityId: ctx.personalityId }),
    ...(ctx.teamId !== undefined && { teamId: ctx.teamId }),
    ...(ctx.agentId !== undefined && { agentId: ctx.agentId }),
    ...(ctx.rootSessionKey !== undefined && { rootSessionKey: ctx.rootSessionKey }),
    ...(ctx.jobId !== undefined && { jobId: ctx.jobId }),
    ...(ctx.reviewOfJobId !== undefined && { reviewOfJobId: ctx.reviewOfJobId }),
    ...(ctx.roomAudience !== undefined && { roomAudience: ctx.roomAudience }),
    ...(ctx.initiator !== undefined && { initiator: ctx.initiator }),
    ...(ctx.toolsetNarrowing && { toolsetNarrowing: ctx.toolsetNarrowing }),
    ...(ctx.origin !== undefined && { origin: ctx.origin }),
    ...(ctx.memoryScopeId !== undefined && { memoryScopeId: ctx.memoryScopeId }),
    ...(ctx.userScopeId !== undefined && { userScopeId: ctx.userScopeId }),
    currentTurn: ctx.currentTurn,
    messageCount: ctx.messageCount,
    resultBudgetChars: ctx.resultBudgetChars,
    ...(ctx.networkPolicy && { networkPolicy: ctx.networkPolicy }),
    ...(ctx.dryRun !== undefined && { dryRun: ctx.dryRun }),
  };
}

export function createNodeProxyTool(base: Tool, hub: NodeHub): Tool {
  const name = `${NODE_TOOL_PREFIX}${base.name}`;
  // `ref` (read_file's attachment handle) is not advertised: a node has no attachments, and a
  // strict-schema provider fills every advertised optional (pinned by node-proxy.test.ts).
  const { ref: _attachmentRef, ...baseProps } = isRecord(base.schema.properties)
    ? base.schema.properties
    : {};
  return {
    name,
    description: `Runs ${base.name} on a connected laptop node, not on this server. Paths are paths on that laptop (see node_list for its roots). ${base.description}`,
    schema: { ...base.schema, properties: { ...baseProps, node: NODE_ARG } },
    toolset: 'node',
    maxResultChars: Math.min(base.maxResultChars ?? NODE_RESULT_CAP_CHARS, NODE_RESULT_CAP_CHARS),
    capabilities: {},
    outputIsUntrusted: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      // Plan D13: shared rooms never reach a laptop. Pinned by node-proxy.test.ts
      // ("refuses a shared room and sends no frame"); the node refuses it too (node-guard.test.ts).
      if (ctx.roomAudience === 'shared') {
        return {
          ok: false,
          code: 'not_available',
          error: 'node tools are not available in shared rooms',
        };
      }
      if (!isRecord(args)) {
        return { ok: false, code: 'input_invalid', error: 'args must be an object' };
      }
      const { node, ...rest } = args;
      if (node !== undefined && typeof node !== 'string') {
        return { ok: false, code: 'input_invalid', error: 'node must be a string', field: 'node' };
      }
      const request = buildRequest(base.name, rest, ctx);
      // Plan D14: node progress is always re-emitted as internal, whatever the frame says
      // (the node cannot promote its own events). Pinned by node-proxy.test.ts.
      const onProgress = (message: string) => {
        const event: ToolProgressEvent = {
          type: 'progress',
          toolName: name,
          message: capProgress(message),
          audience: 'internal',
        };
        ctx.emit(event);
      };
      const transport = new NodeToolTransport(hub, {
        ...(node !== undefined && node !== '' && { node }),
        timeoutMs: nodeCallTimeoutMs(base.name, rest),
        onProgress,
      });
      // The node is not trusted: bound its text, drop its cost_usd and cause (node-proxy.test.ts).
      const result = await transport.execute(request, ctx.abortSignal);
      return capNodeResult(result, ctx.resultBudgetChars);
    },
  };
}

export function createNodeListTool(hub: NodeHub): Tool {
  return {
    name: 'node_list',
    description:
      'Lists laptop nodes known to this server: name, online state, the folders (roots) each exposes, and which personalities may use it.',
    schema: { type: 'object', properties: {} },
    toolset: 'node',
    capabilities: {},
    // Names and roots are node-supplied, so the listing is adversary-controlled text.
    outputIsUntrusted: true,
    async execute(): Promise<ToolResult> {
      return { ok: true, value: JSON.stringify(hub.list()) };
    },
  };
}
