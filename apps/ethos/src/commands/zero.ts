import { fstatSync } from 'node:fs';
import { format as formatArgs } from 'node:util';
import { readConfig } from '@ethosagent/config';
import { createEventTranslator, credentialInstruction } from '@ethosagent/surface-kit';
import { answerSuffix, EthosError, toEthosError } from '@ethosagent/types';
import { applyCliOverrides, parseCliOverrideFlags } from '../cli-overrides';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { getSecretsResolver, getStorage, resolveActiveLoop } from '../wiring';
import {
  buildResultLine,
  createJsonlWriter,
  encodeZeroEvent,
  type ZeroResultError,
} from './zero-stream';

/**
 * One-shot non-interactive runner (`ethos -z "<prompt>"`).
 *
 * Runs a single turn, streams text to stdout, then exits. Designed for
 * shell pipelines: `echo "explain this" | ethos -z` or
 * `ethos -z "summarise" < file.txt`.
 *
 * `--format json|stream-json` turns stdout into a JSONL protocol for scripts
 * (see `./zero-stream.ts`); `text`, the default, is unchanged.
 */
/**
 * Whether stdin carries input to read: a pipe or a redirected file. A TTY, a
 * character device (`/dev/null`) or an inherited socket is skipped — reading
 * one waits for an EOF that a background launch never sends, so
 * `ethos -z "<prompt>" &` hung forever. Pinned by
 * `__tests__/zero-exit-code.test.ts` "does not read stdin that is not a pipe or a file".
 */
function stdinHasInput(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    // fd 0 closed or unreadable: there is nothing to read.
    return false;
  }
}

export const ZERO_FORMATS = ['text', 'json', 'stream-json'] as const;
export type ZeroFormat = (typeof ZERO_FORMATS)[number];

export interface ZeroArgs {
  /** `''` when no prompt token was given (stdin may still supply one). */
  prompt: string;
  format: ZeroFormat;
  noStream: boolean;
  sessionKey: string;
}

/** Flags `-z` understands that take a value. */
const VALUE_FLAGS = new Set([
  '--format',
  '--session',
  '--model',
  '--provider',
  '--personality',
  '--toolsets',
  '-s',
]);
/** Flags `-z` understands that take no value. */
const BARE_FLAGS = new Set(['-z', '--zero', '--no-stream']);

/**
 * Parse `ethos -z` argv. The prompt is the first token after `-z`/`--zero`
 * that is not a known flag or a known flag's value (D34), so the flags-first
 * form `ethos -z --format stream-json "…"` works and a prompt that merely
 * starts with `-` (`-z "-5 degrees?"`) still does too. A flag's value is the
 * next token unless that token starts with `-`, the rule
 * `parseCliOverrideFlags` already applies to the override flags.
 *
 * @throws {EthosError} INVALID_INPUT — a `--format` value other than
 *   `text`, `json` or `stream-json` (D25). Pinned by `zero-format.test.ts`.
 */
export function parseZeroArgs(argv: string[]): ZeroArgs {
  let prompt: string | undefined;
  let format: string | undefined;
  let formatGiven = false;
  let session: string | undefined;
  let seenZero = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('-') ? next : undefined;
      if (value !== undefined) i++;
      if (token === '--format') {
        formatGiven = true;
        format = value;
      } else if (token === '--session') {
        session ??= value;
      }
      continue;
    }
    if (BARE_FLAGS.has(token)) {
      if (token === '-z' || token === '--zero') seenZero = true;
      continue;
    }
    if (seenZero && prompt === undefined) prompt = token;
  }

  if (formatGiven && !(ZERO_FORMATS as readonly string[]).includes(format ?? '')) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `--format ${format === undefined ? 'needs a value' : `"${format}" is not supported`}`,
      action: `Use --format ${ZERO_FORMATS.join('|')}.`,
    });
  }

  return {
    prompt: prompt ?? '',
    format: (format as ZeroFormat | undefined) ?? 'text',
    noStream: argv.includes('--no-stream'),
    sessionKey: session ?? `zero:${Date.now()}`,
  };
}

/**
 * In `json`/`stream-json`, stdout carries only JSON lines (D31):
 * `ConsoleLogger.info` (`packages/logger/src/index.ts`) and any plugin's
 * `console.log` write to stdout, so they are rebound to stderr for the rest of
 * the process. `-z` exits right after `runZero`, so a process-wide rebind is
 * safe — the same rule as `apps/acp-server/src/index.ts`, where stdout IS the
 * protocol. Pinned by the `console.log('noise')` case in `zero-format.test.ts`.
 */
function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${formatArgs(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function readStdinInput(): Promise<string> {
  // Read piped or redirected stdin only — see stdinHasInput.
  if (!stdinHasInput()) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function runZero(argv: string[]): Promise<void> {
  let args: ZeroArgs;
  try {
    args = parseZeroArgs(argv);
  } catch (err) {
    // The one failure with no `result` line: the format itself is unknown (D32).
    process.stderr.write(`ethos -z: ${toEthosError(err).message}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.format === 'text') return runZeroText(argv, args);
  return runZeroStructured(argv, args);
}

async function runZeroText(argv: string[], args: ZeroArgs): Promise<void> {
  const { prompt, noStream, sessionKey } = args;
  const stdinContent = await readStdinInput();
  const fullPrompt = stdinContent ? `${prompt}\n\n\`\`\`\n${stdinContent}\n\`\`\`` : prompt;

  if (!fullPrompt) {
    process.stderr.write('ethos -z: no prompt provided\n');
    process.exitCode = 1;
    return;
  }

  const cliFlags = parseCliOverrideFlags(argv);
  const storage = getStorage();
  const secrets = await getSecretsResolver();
  const config = await readConfig(storage, secrets);
  if (!config) {
    process.stderr.write('ethos -z: no config found. Run `ethos setup` first.\n');
    process.exitCode = 1;
    return;
  }

  const withOverrides = await applyCliOverrides(config, cliFlags, storage);
  const runtime = await resolveActiveLoop(withOverrides);
  const { loop, personalityId } = runtime;

  try {
    let streamed = '';
    for await (const event of loop.run(fullPrompt, {
      sessionKey,
      personalityId,
      // No masked input on a one-shot pipe: a missing plugin credential ends
      // the turn with the one-line CLI instruction instead.
      credentialPrompt: true,
    })) {
      if (event.type === 'credential_required') {
        process.stderr.write(`${credentialInstruction(event)}\n`);
        process.exitCode = 1;
      }
      if (event.type === 'text_delta') {
        streamed += event.text;
        if (!noStream) process.stdout.write(event.text);
      }
      // A `returnDirect` tool's answer arrives only as `done.text`, after any
      // preamble that streamed: `answerSuffix` is what the stream still owes.
      // Streaming prints just that; `--no-stream` prints the whole reply.
      if (event.type === 'done') {
        const owed = answerSuffix(streamed, event.text);
        const out = noStream ? streamed + owed : owed;
        if (out) process.stdout.write(out);
      }
      if (event.type === 'error') {
        process.stderr.write(`[${event.code}] ${event.error}\n`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    process.stderr.write(`ethos -z: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await releaseCommandRuntime(runtime);
  }

  // Trailing newline for shell consumers
  process.stdout.write('\n');
}

/**
 * `--format json|stream-json`. Exactly one `result` line on every exit path
 * after flag parsing, written after the iterator is EXHAUSTED — not at `done`,
 * because usage and the memory flush come after it (CLAUDE.md's drain rule;
 * the translator's `stopped` is never used to break). Exit codes match text
 * mode: 1 for an `error` event, a throw, no prompt, no config or a refused
 * override; a halt exits 0 and shows in `result.halt` (D32). Setup throws get
 * their `result` line and are then rethrown, so `index.ts`'s top-level handler
 * still renders them and appends them to `errors.jsonl`. Every exit flushes
 * stdout first (D33). Pinned by `zero-format.test.ts`.
 */
async function runZeroStructured(argv: string[], args: ZeroArgs): Promise<void> {
  const { format, prompt, sessionKey } = args;
  const startedAt = Date.now();
  routeConsoleToStderr();
  const writer = createJsonlWriter(process.stdout);
  const translator = createEventTranslator();
  let traceId: string | undefined;

  const finish = async (error?: ZeroResultError): Promise<void> => {
    await writer.write(
      buildResultLine(translator, {
        sessionKey,
        durationMs: Date.now() - startedAt,
        ...(traceId !== undefined ? { traceId } : {}),
        ...(error ? { error } : {}),
      }),
    );
    await writer.flush();
  };
  const refuse = async (code: string, message: string): Promise<void> => {
    process.stderr.write(`ethos -z: ${message}\n`);
    process.exitCode = 1;
    await finish({ code, message });
  };

  let runtime: Awaited<ReturnType<typeof resolveActiveLoop>>;
  let fullPrompt: string;
  try {
    const stdinContent = await readStdinInput();
    fullPrompt = stdinContent ? `${prompt}\n\n\`\`\`\n${stdinContent}\n\`\`\`` : prompt;
    if (!fullPrompt) return await refuse('INVALID_INPUT', 'no prompt provided');

    const cliFlags = parseCliOverrideFlags(argv);
    const storage = getStorage();
    const secrets = await getSecretsResolver();
    const config = await readConfig(storage, secrets);
    if (!config) {
      return await refuse('CONFIG_MISSING', 'no config found. Run `ethos setup` first.');
    }
    const withOverrides = await applyCliOverrides(config, cliFlags, storage);
    runtime = await resolveActiveLoop(withOverrides);
  } catch (err) {
    const e = toEthosError(err);
    process.exitCode = 1;
    await finish({ code: e.code, message: e.message });
    throw err;
  }

  const { loop, personalityId } = runtime;
  let thrown: ZeroResultError | undefined;
  try {
    if (format === 'stream-json') {
      const { buildVersionInfo } = await import('../version-info');
      await writer.write({
        v: 1,
        type: 'init',
        sessionKey,
        personalityId,
        ethosVersion: buildVersionInfo().version,
      });
    }
    // `credentialPrompt` — a refusal lands in `result.error` (`buildResultLine`).
    for await (const event of loop.run(fullPrompt, {
      sessionKey,
      personalityId,
      credentialPrompt: true,
    })) {
      translator.push(event);
      if (event.type === 'credential_required') {
        process.stderr.write(`ethos -z: ${credentialInstruction(event)}\n`);
        process.exitCode = 1;
      }
      if (event.type === 'run_start' && event.traceId !== undefined) traceId ??= event.traceId;
      if (event.type === 'done' && event.traceId !== undefined) traceId = event.traceId;
      if (event.type === 'error') process.exitCode = 1;
      if (format !== 'stream-json') continue;
      const line = encodeZeroEvent(event);
      if (line) await writer.write(line);
    }
  } catch (err) {
    const e = toEthosError(err);
    process.stderr.write(`ethos -z: ${e.message}\n`);
    process.exitCode = 1;
    thrown = { code: e.code, message: e.message };
  }

  try {
    await finish(thrown);
  } finally {
    await releaseCommandRuntime(runtime);
    await writer.flush();
  }
}
