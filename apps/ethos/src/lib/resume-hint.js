function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0)
        return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}
export function formatResumeHint(input) {
    if (input.userMessageCount === 0)
        return null;
    const lines = [
        'Resume this session with:',
        `  ethos --resume ${input.sessionId}`,
        '',
        `Session:        ${input.sessionId}`,
    ];
    if (input.title) {
        lines.push(`Title:          ${input.title}`);
    }
    lines.push(`Duration:       ${formatDuration(input.durationMs)}`);
    lines.push(`Messages:       ${input.totalMessageCount} (${input.userMessageCount} user)`);
    return lines.join('\n');
}
