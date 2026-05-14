import type { Tool, ToolResult } from '@ethosagent/types';

export function createThinkDeeperTool(): Tool {
  return {
    name: 'think_deeper',
    description:
      'Escalate the next LLM call to the deep model tier for complex reasoning. ' +
      'Use when a task requires multi-step analysis, large refactors, or deep research. ' +
      'The escalation is one-shot: only the immediately following LLM call uses the deep tier.',
    toolset: 'tier',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'One-line justification for why deep thinking is needed',
        },
      },
      required: ['reason'],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const { reason } = args as { reason: string };
      return { ok: true, value: `Escalating to deep tier. Reason: ${reason}` };
    },
  };
}
