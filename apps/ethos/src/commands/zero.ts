import { applyCliOverrides, parseCliOverrideFlags } from '../cli-overrides';
import { readConfig } from '../config';
import { getSecretsResolver, getStorage, resolveActiveLoop } from '../wiring';

/**
 * One-shot non-interactive runner (`ethos -z "<prompt>"`).
 *
 * Runs a single turn, streams text to stdout, then exits. Designed for
 * shell pipelines: `echo "explain this" | ethos -z` or
 * `ethos -z "summarise" < file.txt`.
 */
export async function runZero(argv: string[], prompt: string): Promise<void> {
  // Read piped stdin if not a TTY
  let stdinContent = '';
  if (!process.stdin.isTTY) {
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
  const { loop, personalityId } = await resolveActiveLoop(withOverrides);

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
    for await (const event of loop.run(fullPrompt, {
      sessionKey,
      personalityId,
    })) {
      if (event.type === 'text_delta' && !noStream) {
        process.stdout.write(event.text);
      }
      if (event.type === 'done' && noStream) {
        process.stdout.write(event.text);
      }
      if (event.type === 'error') {
        process.stderr.write(`[${event.code}] ${event.error}\n`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    process.stderr.write(`ethos -z: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }

  // Trailing newline for shell consumers
  process.stdout.write('\n');
}
