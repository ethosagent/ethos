export function writeJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export function writeJsonError(code: string, message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exit(1);
}
