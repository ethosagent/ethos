// Structured JSON logger — writes exclusively to stderr.
// stdout must be pure JSON-RPC frames; any stray output will corrupt MCP clients.
function write(level, msg, data) {
    const entry = { level, msg, ts: new Date().toISOString() };
    if (data !== undefined)
        entry.data = data;
    process.stderr.write(`${JSON.stringify(entry)}\n`);
}
export const logger = {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
};
