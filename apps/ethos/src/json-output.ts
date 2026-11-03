export function writeJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export function writeJsonError(code: string, message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exit(1);
}

/** Where a progress line goes: stdout in text mode, stderr under `--json` (stdout holds the one document). */
export type Say = (line: string) => void;

export const sayFor = (json: boolean): Say =>
  json ? (line) => console.error(line) : (line) => console.log(line);

/**
 * A command that prompts for confirmation cannot run under `--json`: refuse with one
 * INVALID_INPUT document. `unlessFlag` names a flag (e.g. `--yes`) that skips the prompt.
 */
export function refuseJson(argv: string[], message: string, opts?: { unlessFlag?: string }): void {
  if (!argv.includes('--json')) return;
  if (opts?.unlessFlag && argv.includes(opts.unlessFlag)) return;
  writeJsonError('INVALID_INPUT', message);
}
