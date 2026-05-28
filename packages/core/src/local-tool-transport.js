import { resolveCapabilities } from './capability-resolver';
export class LocalToolTransport {
    lookup;
    backends;
    getLiveCtx;
    constructor(lookup, backends, getLiveCtx) {
        this.lookup = lookup;
        this.backends = backends;
        this.getLiveCtx = getLiveCtx;
    }
    async execute(request, signal) {
        const tool = this.lookup(request.name);
        if (!tool) {
            return { ok: false, error: `Tool '${request.name}' not found`, code: 'not_available' };
        }
        const live = this.getLiveCtx?.();
        const ctx = {
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
            emit: live?.emit ?? (() => { }),
            readMtimes: live?.readMtimes,
            storage: live?.storage,
        };
        if (tool.capabilities && this.backends) {
            const resolved = resolveCapabilities(tool.name, tool.capabilities, { sessionId: request.sessionId, personalityId: request.personalityId }, { ...this.backends, inboundAttachments: live?.inboundAttachments });
            Object.assign(ctx, resolved);
        }
        return tool.execute(request.args, ctx);
    }
}
