const MAX_LINES = 200;
function hasExplicitRange(args) {
    if (!args || typeof args !== 'object')
        return false;
    const a = args;
    return a.lineStart !== undefined || a.lineEnd !== undefined;
}
export const readFileReducer = {
    toolName: 'read_file',
    reduce(result, ctx) {
        if (!result.ok)
            return result;
        if (hasExplicitRange(ctx.args))
            return result;
        const lines = result.value.split('\n');
        if (lines.length <= MAX_LINES)
            return result;
        const kept = lines.slice(0, MAX_LINES).join('\n');
        const hint = `File is ${lines.length} lines. Showing lines 1-${MAX_LINES}. Call read_file with lineStart/lineEnd for more.`;
        return { ok: true, value: `${hint}\n${kept}` };
    },
};
