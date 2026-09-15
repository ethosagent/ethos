import { fstatSync } from 'node:fs';
import { readConfig } from '@ethosagent/config';
import { answerSuffix } from '@ethosagent/types';
import { applyCliOverrides, parseCliOverrideFlags } from '../cli-overrides';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { getSecretsResolver, getStorage, resolveActiveLoop } from '../wiring';

/**
 * One-shot non-interactive runner (`ethos -z "<prompt>"`).
 *
 * Runs a single turn, streams text to stdout, then exits. Designed for
 * shell pipelines: `echo "explain this" | ethos -z` or
 * `ethos -z "summarise" < file.txt`.
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

export async function runZero(argv: string[], prompt: string): Promise<void> {
  // Read piped or redirected stdin only — see stdinHasInput.
  let stdinContent = '';
  if (stdinHasInput()) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    stdinContent = Buffer.concat(chunks).toString('utf8').trim();
  }

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

  const noStream = argv.includes('--no-stream');
  // Parse --session from argv
  let sessionKey = `zero:${Date.now()}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session' && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val && !val.startsWith('-')) {
        sessionKey = val;
        break;
      }
    }
  }

  try {
    let streamed = '';
    for await (const event of loop.run(fullPrompt, {
      sessionKey,
      personalityId,
    })) {
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
