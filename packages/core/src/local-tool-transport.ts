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
  /**
   * A2A delegation frame (plan §P8). Carries a live `reserveOutbound` callback,
   * so it cannot ride the serializable `ToolExecuteRequest` — it must travel on
   * this live side-channel and be re-attached to the reconstructed ctx.
   */
  a2aDelegation?: { traceId: string; depth: number; reserveOutbound: () => boolean };
  /**
   * Script-tool seam (tools-as-code-api Lane B). Carries live callbacks — like
   * `a2aDelegation` it cannot ride the serializable `ToolExecuteRequest` and
   * must be re-attached to the reconstructed ctx.
   */
  scriptTools?: import('@ethosagent/types').ScriptToolsApi;
  /**
   * Turn-scoped LLM handle. Closes over the turn's usage sink (built in
   * `agent-loop/stages/tool-processing.ts`), so — like `a2aDelegation` and
   * `scriptTools` — it cannot ride the serializable `ToolExecuteRequest` and
   * must be re-attached to the reconstructed ctx here.
   *
   * A non-local `ToolTransport` (remote/A2A) legitimately cannot carry this
   * handle across its boundary, so `ctx.llm` stays optional and tools must
   * degrade when it is absent. That is intended, not a gap.
   */
  llm?: import('@ethosagent/types').SimpleCompletion;
  /**
   * The run's context store accessors (`ContextStore.asContextMethods`, wired in
   * `agent-loop/stages/tool-processing.ts`). Closures over a live store, so they
   * cannot ride the serializable `ToolExecuteRequest`.
   */
  getContext?: <T>(key: string) => T | undefined;
  setContext?: <T>(key: string, value: T) => void;
}

/**
 * Rebuilds a tool's `ToolContext` from the serializable request (wire), the live
 * side-channel (callbacks and handles), and capability resolution (derived).
 * Field-by-field parity with the caller's ctx is pinned by
 * `packages/core/src/__tests__/tool-transport-hop.test.ts`, whose `PARTITION`
 * must classify every `ToolContext` key.
 */
export class LocalToolTransport implements ToolTransport {
  constructor(
    private readonly lookup: (name: string) => Tool | undefined,
    private readonly backends?: CapabilityBackends,
  ) {}

  /**
   * The `ToolTransport` contract's entry point: wire state only. Live state has
   * no channel here, so a tool reached this way gets none — the local caller
   * that HAS it (`DefaultToolRegistry.executeParallel`) calls
   * {@link LocalToolTransport.executeWithLive} instead.
   */
  async execute(request: ToolExecuteRequest, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithLive(request, signal, undefined);
  }

  /**
   * Execute with this batch's live state passed IN, so it is bound to this one
   * invocation. `DefaultToolRegistry.executeParallel` uses it: a registry-level
   * slot (or a getter over one) returns whichever batch wrote it last, and a
   * batch that awaits — an async invocation filter — would resume with another
   * batch's handles. Pinned by the "interleaved batches" tests in
   * `__tests__/tool-transport-hop.test.ts`.
   */
  async executeWithLive(
    request: ToolExecuteRequest,
    signal: AbortSignal,
    live: LocalToolTransportLiveCtx | undefined,
  ): Promise<ToolResult> {
    const tool = this.lookup(request.name);
    if (!tool) {
      return { ok: false, error: `Tool '${request.name}' not found`, code: 'not_available' };
    }

    const ctx: ToolContext = {
      toolCallId: request.toolCallId,
      sessionId: request.sessionId,
      sessionKey: request.sessionKey,
      platform: request.platform,
      workingDir: request.workingDir,
      personalityId: request.personalityId,
      teamId: request.teamId,
      agentId: request.agentId,
      rootSessionKey: request.rootSessionKey,
      jobId: request.jobId,
      ...(request.reviewOfJobId !== undefined ? { reviewOfJobId: request.reviewOfJobId } : {}),
      ...(request.toolsetNarrowing ? { toolsetNarrowing: request.toolsetNarrowing } : {}),
      origin: request.origin,
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
      a2aDelegation: live?.a2aDelegation,
      scriptTools: live?.scriptTools,
      llm: live?.llm,
      getContext: live?.getContext,
      setContext: live?.setContext,
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
