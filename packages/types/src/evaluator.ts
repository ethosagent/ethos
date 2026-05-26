import type { ToolContext } from './tool';

export interface PostTurnEvaluatorPayload {
  text: string;
  sessionId: string;
  turnIndex: number;
}

export interface PostTurnEvaluator {
  name: string;
  shouldRun(payload: PostTurnEvaluatorPayload): boolean;
  evaluate(
    payload: PostTurnEvaluatorPayload,
    ctx: Pick<ToolContext, 'sessionId' | 'getContext' | 'setContext'>,
  ): Promise<{ pass: boolean; reason?: string; score?: number }>;
}
