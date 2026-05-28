export function writeJson(data) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
}
export function writeJsonError(code, message) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    process.exit(1);
}
