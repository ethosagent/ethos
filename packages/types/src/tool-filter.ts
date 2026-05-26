import type { ToolContext, ToolResult } from './tool';

export interface ToolInvocationFilter {
  toolName?: string | string[];
  toolset?: string;
  before?: (
    args: unknown,
    ctx: ToolContext,
    meta: { toolName: string; toolCallId: string },
  ) => Promise<ToolResult | null>;
  after?: (
    result: ToolResult,
    ctx: ToolContext,
    meta: { toolName: string; toolCallId: string },
  ) => Promise<ToolResult>;
}
