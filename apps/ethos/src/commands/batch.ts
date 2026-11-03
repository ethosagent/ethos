import { readFile } from 'node:fs/promises';
import { BatchRunner, parseTasksJsonl } from '@ethosagent/batch-runner';
import type { EthosConfig } from '@ethosagent/config';
import { EthosError } from '@ethosagent/types';
import { sayFor, writeJson, writeJsonError } from '../json-output';
import { gateNonInteractiveLoop } from '../lib/non-interactive-approval';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { createAgentLoop, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function parseArgs(args: string[]): {
  inputPath: string;
  concurrency: number;
  outputPath: string;
  checkpointPath: string;
} {
  let inputPath = '';
  let concurrency = 3;
  let outputPath = '';
  let checkpointPath = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--concurrency' || arg === '-c') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1)
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: '--concurrency must be a positive integer',
          action: 'Pass a positive integer, e.g. --concurrency 4.',
        });
      concurrency = n;
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i] ?? '';
    } else if (arg === '--checkpoint') {
      checkpointPath = args[++i] ?? '';
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  if (!inputPath)
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'ethos batch requires a tasks file',
      action:
        'Usage: ethos batch <tasks.jsonl> [--concurrency N] [--output out.jsonl] [--checkpoint cp.json] [--json]',
    });

  const base = inputPath.replace(/\.jsonl$/, '');
  if (!outputPath) outputPath = `${base}.output.jsonl`;
  if (!checkpointPath) checkpointPath = `${base}.checkpoint.json`;

  return { inputPath, concurrency, outputPath, checkpointPath };
}

/** The stats of an empty task file: nothing completed, failed or skipped. */
const NO_TASKS_RAN = { completed: 0, failed: 0, skipped: 0 };

export async function runBatch(args: string[], config: EthosConfig): Promise<void> {
  const json = args.includes('--json');
  const say = sayFor(json);
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(args);
  } catch (err) {
    if (json) throw err;
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  const { inputPath, concurrency, outputPath, checkpointPath } = opts;

  let src: string;
  try {
    src = await readFile(inputPath, 'utf-8');
  } catch {
    if (json) writeJsonError('FILE_NOT_FOUND', `Cannot read input file: ${inputPath}`);
    console.error(`${c.red}Cannot read input file: ${inputPath}${c.reset}`);
    process.exit(1);
  }

  let tasks: ReturnType<typeof parseTasksJsonl>;
  try {
    tasks = parseTasksJsonl(src);
  } catch (err) {
    if (json) {
      writeJsonError(
        'BATCH_INVALID_LINE',
        `Invalid tasks file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.error(
      `${c.red}Invalid tasks file: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  const document = (stats: typeof NO_TASKS_RAN, secs: number) => ({
    ok: true,
    tasks: tasks.length,
    concurrency,
    completed: stats.completed,
    failed: stats.failed,
    skipped: stats.skipped,
    elapsedSeconds: secs,
    output: outputPath,
    checkpoint: checkpointPath,
  });

  if (tasks.length === 0) {
    if (json) {
      writeJson(document(NO_TASKS_RAN, 0));
      return;
    }
    console.log(`${c.yellow}No tasks found in ${inputPath}${c.reset}`);
    return;
  }

  say(
    `${c.bold}ethos batch${c.reset}  ${c.dim}${tasks.length} tasks · concurrency ${concurrency}${c.reset}`,
  );
  say(`${c.dim}  output     → ${outputPath}${c.reset}`);
  say(`${c.dim}  checkpoint → ${checkpointPath}${c.reset}\n`);

  const runtime = await createAgentLoop(config);
  gateNonInteractiveLoop(runtime, config, '`ethos batch` has no prompt to answer it');

  const runner = new BatchRunner(
    runtime.loop,
    {
      concurrency,
      outputPath,
      checkpointPath,
      defaultPersonalityId: config.personality,
    },
    getStorage(),
  );

  const start = Date.now();
  let lastLine = '';

  const stats = await runner
    .run(
      tasks,
      json
        ? undefined
        : (done, total) => {
            // Overwrite progress line in terminal
            const pct = Math.round((done / total) * 100);
            const line = `  ${done}/${total} (${pct}%)`;
            process.stdout.write(`\r${line.padEnd(lastLine.length + 2)}`);
            lastLine = line;
          },
    )
    .finally(() => releaseCommandRuntime(runtime, { label: 'batch agent loop' }));

  if (lastLine) process.stdout.write('\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (json) {
    writeJson(document(stats, Number(elapsed)));
    // Failed tasks still exit 1; the document above says how many.
    if (stats.failed > 0) process.exit(1);
    return;
  }
  const failMark = stats.failed > 0 ? `${c.red}${stats.failed} failed${c.reset}  ` : '';
  const skipMark = stats.skipped > 0 ? `${c.dim}${stats.skipped} skipped${c.reset}  ` : '';

  console.log(
    `\n${c.green}✓${c.reset} ${c.bold}${stats.completed} completed${c.reset}  ${failMark}${skipMark}${c.dim}${elapsed}s${c.reset}`,
  );
  console.log(`${c.dim}output → ${outputPath}${c.reset}`);

  if (stats.failed > 0) process.exit(1);
}
