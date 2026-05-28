export function registerPostmortemHandler(opts) {
    const { teamName, memory, hooks } = opts;
    const ctx = {
        scopeId: `team:${teamName}`,
        sessionId: 'postmortem',
        sessionKey: 'postmortem',
        platform: 'system',
        workingDir: '',
    };
    return hooks.registerVoid('after_ticket_revision', async (payload) => {
        const key = `postmortems/${payload.taskId}.md`;
        const shortId = payload.taskId.slice(0, 8);
        const content = [
            `# ${shortId} — needs revision`,
            '',
            `**Ticket:** ${payload.taskId}`,
            `**Assignee:** ${payload.assignee}`,
            ...(payload.autonomyTier
                ? [`**Tier:** ${payload.autonomyTier} (ratio ${(payload.successRatio ?? 0).toFixed(2)})`]
                : []),
            `**Why it bounced:** ${payload.reason}`,
            '',
            `**Summary submitted:** ${payload.summary}`,
            ...(payload.acceptanceCriteria
                ? ['', `**Acceptance criteria:** ${payload.acceptanceCriteria}`]
                : []),
            '',
        ].join('\n');
        await memory.sync([{ action: 'replace', key, content }], ctx);
    });
}
