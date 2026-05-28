import type {
  Attachment,
  Tool,
  ToolContext,
  ToolExecuteRequest,
  ToolProgressEvent,
  ToolResult,
  ToolTransport,
} from '@ethosagent/types';
import type { CapabilityBackends } from './capability-resolver';
import { resolveCapabilities } from './capability-resolver';

export interface LocalToolTransportLiveCtx {
  emit: (event: ToolProgressEvent) => void;
  readMtimes?: Map<string, { mtimeMs: number; readAtTurn: number }>;
  storage?: import('@ethosagent/types').Storage;
  inboundAttachments?: Attachment[];
}

export class LocalToolTransport implements ToolTransport {
  constructor(
    private readonly lookup: (name: string) => Tool | undefined,
    private readonly backends?: CapabilityBackends,
    private readonly getLiveCtx?: () => LocalToolTransportLiveCtx,
  ) {}

  async execute(request: ToolExecuteRequest, signal: AbortSignal): Promise<ToolResult> {
    const tool = this.lookup(request.name);
    if (!tool) {
      return { ok: false, error: `Tool '${request.name}' not found`, code: 'not_available' };
    }

    const live = this.getLiveCtx?.();

    const ctx: ToolContext = {
      sessionId: request.sessionId,
      sessionKey: request.sessionKey,
      platform: request.platform,
      workingDir: request.workingDir,
      personalityId: request.personalityId,
      teamId: request.teamId,
      agentId: request.agentId,
      memoryScopeId: request.memoryScopeId,
      userScopeId: request.userScopeId,
      currentTurn: request.currentTurn,
      messageCount: request.messageCount,
      resultBudgetChars: request.resultBudgetChars,
      networkPolicy: request.networkPolicy,
      dryRun: request.dryRun,
      abortSignal: signal,
      emit: live?.emit ?? (() => {}),
      readMtimes: live?.readMtimes,
      storage: live?.storage,
    };

    if (tool.capabilities && this.backends) {
      const resolved = resolveCapabilities(
        tool.name,
        tool.capabilities,
        { sessionId: request.sessionId, personalityId: request.personalityId },
        { ...this.backends, inboundAttachments: live?.inboundAttachments },
      );
      Object.assign(ctx, resolved);
    }

    return tool.execute(request.args, ctx);
  }
}
