export function createWebApprovalHook(opts) {
    return async (payload) => {
        const reason = opts.isDangerous(payload);
        if (reason === null)
            return null;
        const decision = await opts.approvals.requestApproval({
            sessionId: payload.sessionId,
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            args: payload.args,
            reason,
        });
        if (decision.decision === 'allow')
            return null;
        return { error: decision.reason };
    };
}
