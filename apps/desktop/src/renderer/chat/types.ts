export interface ToolCallState {
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  result?: string;
  progressMessage?: string;
}

export interface ApprovalState {
  approvalId: string;
  toolName: string;
  args: unknown;
  reason: string | null;
}

export interface ClarifyState {
  requestId: string;
  question: string;
  options?: string[];
  defaultAnswer?: string;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}
