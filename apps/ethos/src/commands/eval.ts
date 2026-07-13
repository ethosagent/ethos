import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTasksJsonl } from '@ethosagent/batch-runner';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import {
  aggregateByCategory,
  EvalRunner,
  parseExpectedJsonl,
  type RepairEvent,
  summarizeRepairs,
} from '@ethosagent/eval-harness';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { loadEvolveConfig, SkillEvolver } from '@ethosagent/skill-evolver';
import { EthosError } from '@ethosagent/types';
import { createAgentLoop, createLLM, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

type Scorer = 'exact' | 'contains' | 'regex' | 'llm';

function isScorer(v: string): v is Scorer {
  return v === 'exact' || v === 'contains' || v === 'regex' || v === 'llm';
}

function parseArgs(args: string[]): {
  inputPath: string;
  expectedPath: string;
  outputPath: string;
  scorer: Scorer;
  concurrency: number;
  evolve: boolean;
  autoApprove: boolean;
} {
  let inputPath = '';
  let expectedPath = '';
  let outputPath = '';
  let scorer: Scorer = 'contains';
  let concurrency = 3;
  let evolve = false;
  let autoApprove = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--expected' || arg === '-e') {
      expectedPath = args[++i] ?? '';
    } else if (arg === '--scorer' || arg === '-s') {
      const val = args[++i] ?? '';
      if (!isScorer(val))
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `--scorer must be one of: exact, contains, regex, llm (got: ${val})`,
          action: 'Pass one of the four supported scorers.',
        });
      scorer = val;
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i] ?? '';
    } else if (arg === '--concurrency' || arg === '-c') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1)
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: '--concurrency must be a positive integer',
          action: 'Pass a positive integer, e.g. --concurrency 4.',
        });
      concurrency = n;
    } else if (arg === '--evolve') {
      evolve = true;
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  if (!inputPath)
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'ethos eval run requires a tasks file',
      action:
        'Usage: ethos eval run <tasks.jsonl> --expected <expected.jsonl> [--scorer exact|contains|regex|llm] [--concurrency N] [--output out.jsonl] [--evolve [--auto-approve]]',
    });
  if (!expectedPath)
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: '--expected <expected.jsonl> is required',
      action: 'Pass --expected pointing at a JSONL file with expected outputs.',
    });

  const base = inputPath.replace(/\.jsonl$/, '');
  if (!outputPath) outputPath = `${base}.eval.jsonl`;

  return { inputPath, expectedPath, outputPath, scorer, concurrency, evolve, autoApprove };
}

export async function runEval(subArgs: string[], config: EthosConfig): Promise<void> {
  const sub = subArgs[0] ?? '';
  const rest = subArgs.slice(1);

  if (sub === 'local') {
    await runEvalLocal(rest, config);
    return;
  }

  if (sub !== 'run') {
    console.log('Usage: ethos eval run <tasks.jsonl> --expected <expected.jsonl> [options]');
    console.log('       ethos eval local [--model <id>] [--dataset evals/local]');
    console.log('');
    console.log('Options (run):');
    console.log('  --expected, -e   Path to expected outputs JSONL (required)');
    console.log('  --scorer, -s     Scorer: exact | contains | regex | llm  (default: contains)');
    console.log('  --concurrency -c Concurrent tasks (default: 3)');
    console.log('  --output, -o     Output path (default: <input>.eval.jsonl)');
    console.log('  --evolve         After scoring, run skill evolver on the output');
    console.log('  --auto-approve   With --evolve, promote pending skills automatically');
    console.log('');
    console.log('Options (local):');
    console.log('  --model, -m      Model id to score (default: configured model)');
    console.log('  --dataset, -d    Dataset directory (default: evals/local)');
    console.log('  --concurrency -c Concurrent tasks (default: 3)');
    return;
  }

  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  const { inputPath, expectedPath, outputPath, scorer, concurrency, evolve, autoApprove } = opts;

  let taskSrc: string;
  try {
    taskSrc = await readFile(inputPath, 'utf-8');
  } catch {
    console.error(`${c.red}Cannot read tasks file: ${inputPath}${c.reset}`);
    process.exit(1);
  }

  let expectedSrc: string;
  try {
    expectedSrc = await readFile(expectedPath, 'utf-8');
  } catch {
    console.error(`${c.red}Cannot read expected file: ${expectedPath}${c.reset}`);
    process.exit(1);
  }

  let tasks: ReturnType<typeof parseTasksJsonl>;
  try {
    tasks = parseTasksJsonl(taskSrc);
  } catch (err) {
    console.error(
      `${c.red}Invalid tasks file: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  let expectedMap: ReturnType<typeof parseExpectedJsonl>;
  try {
    expectedMap = parseExpectedJsonl(expectedSrc);
  } catch (err) {
    console.error(
      `${c.red}Invalid expected file: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  if (tasks.length === 0) {
    console.log(`${c.yellow}No tasks found in ${inputPath}${c.reset}`);
    return;
  }

  console.log(
    `${c.bold}ethos eval${c.reset}  ${c.dim}${tasks.length} tasks · scorer: ${scorer} · concurrency ${concurrency}${c.reset}`,
  );
  console.log(`${c.dim}  expected   → ${expectedPath}${c.reset}`);
  console.log(`${c.dim}  output     → ${outputPath}${c.reset}\n`);

  const { loop } = await createAgentLoop(config);
  const runner = new EvalRunner(loop, {
    concurrency,
    outputPath,
    defaultScorer: scorer,
    storage: getStorage(),
  });

  const start = Date.now();
  let lastLine = '';

  const stats = await runner.run(tasks, expectedMap, (done, total) => {
    const pct = Math.round((done / total) * 100);
    const line = `  ${done}/${total} (${pct}%)`;
    process.stdout.write(`\r${line.padEnd(lastLine.length + 2)}`);
    lastLine = line;
  });

  if (lastLine) process.stdout.write('\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const passMark = `${c.green}${stats.passed} passed${c.reset}`;
  const failMark = stats.failed > 0 ? `  ${c.red}${stats.failed} failed${c.reset}` : '';
  const avgMark = `  ${c.dim}avg ${(stats.avgScore * 100).toFixed(0)}%${c.reset}`;

  console.log(`\n${c.bold}${passMark}${failMark}${avgMark}  ${c.dim}${elapsed}s${c.reset}`);
  console.log(`${c.dim}output → ${outputPath}${c.reset}`);

  if (evolve) await runEvolveAfter(config, outputPath, autoApprove);

  if (stats.failed > 0) process.exit(1);
}

async function runEvolveAfter(
  config: EthosConfig,
  evalOutputPath: string,
  autoApprove: boolean,
): Promise<void> {
  const dir = ethosDir();
  const skillsDir = join(dir, 'skills');
  const pendingDir = join(skillsDir, 'pending');
  const evolveConfig = await loadEvolveConfig(join(dir, 'evolve-config.json'), getStorage());
  const llm = await createLLM(config);

  console.log(`\n${c.bold}evolving skills${c.reset}  ${c.dim}model: ${llm.model}${c.reset}`);

  const evolver = new SkillEvolver({
    evalOutputPath,
    skillsDir,
    pendingDir,
    config: evolveConfig,
    llm,
    storage: getStorage(),
  });
  const result = await evolver.evolve();

  console.log(
    `  rewrites: ${result.rewritesWritten.length}  new: ${result.newSkillsWritten.length}  skipped: ${result.skipped.length}`,
  );
  for (const f of result.rewritesWritten) console.log(`  ${c.green}rewrite${c.reset} ${f}`);
  for (const f of result.newSkillsWritten) console.log(`  ${c.green}new${c.reset}     ${f}`);
  for (const s of result.skipped)
    console.log(`  ${c.yellow}skip${c.reset}    ${s.kind} ${s.target} — ${s.reason}`);

  if (autoApprove) {
    const { rename } = await import('node:fs/promises');
    const all = [...result.rewritesWritten, ...result.newSkillsWritten];
    for (const f of all) await rename(join(pendingDir, f), join(skillsDir, f));
    if (all.length > 0) console.log(`  ${c.green}auto-approved${c.reset} ${all.length} file(s)`);
  } else if (result.rewritesWritten.length + result.newSkillsWritten.length > 0) {
    console.log(`  ${c.dim}review with: ethos evolve --list-pending${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// ethos eval local — qualify a local model against the committed evals/local
// suite. Thin wrapper over EvalRunner: runs the suite, aggregates pass rates by
// category (category = the `<category>/<name>` id prefix), and reports the
// tool-call repair rate from §4's `tool.repair` observability events.
// ---------------------------------------------------------------------------

interface LocalOpts {
  model?: string;
  dataset: string;
  concurrency: number;
}

function parseLocalArgs(args: string[]): LocalOpts {
  let model: string | undefined;
  let dataset = 'evals/local';
  let concurrency = 3;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--model' || arg === '-m') {
      model = args[++i] ?? '';
    } else if (arg === '--dataset' || arg === '-d') {
      dataset = args[++i] ?? dataset;
    } else if (arg === '--concurrency' || arg === '-c') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1)
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: '--concurrency must be a positive integer',
          action: 'Pass a positive integer, e.g. --concurrency 4.',
        });
      concurrency = n;
    }
  }

  return { model, dataset, concurrency };
}

/** Read the run's `tool.repair` events from the observability store. Degrades
 *  to an empty list (repair rate unavailable) if the store can't be opened. */
function readRepairEvents(since: number): { events: RepairEvent[]; available: boolean } {
  try {
    const store = new SQLiteObservabilityStore(join(ethosDir(), 'observability.db'));
    const events = store.getEvents({ category: 'tool.repair', since, limit: 1000 });
    return { events, available: true };
  } catch {
    return { events: [], available: false };
  }
}

export async function runEvalLocal(args: string[], config: EthosConfig): Promise<void> {
  let opts: LocalOpts;
  try {
    opts = parseLocalArgs(args);
  } catch (err) {
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  const tasksPath = join(opts.dataset, 'tasks.jsonl');
  const expectedPath = join(opts.dataset, 'expected.jsonl');

  let tasks: ReturnType<typeof parseTasksJsonl>;
  let expectedMap: ReturnType<typeof parseExpectedJsonl>;
  try {
    tasks = parseTasksJsonl(await readFile(tasksPath, 'utf-8'));
    expectedMap = parseExpectedJsonl(await readFile(expectedPath, 'utf-8'));
  } catch (err) {
    console.error(
      `${c.red}Cannot load dataset from ${opts.dataset}: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  if (tasks.length === 0) {
    console.log(`${c.yellow}No tasks found in ${tasksPath}${c.reset}`);
    return;
  }

  const effectiveConfig = opts.model ? { ...config, model: opts.model } : config;
  const outputPath = join(ethosDir(), 'eval-local.eval.jsonl');

  console.log(
    `${c.bold}ethos eval local${c.reset}  ${c.dim}${tasks.length} tasks · model: ${effectiveConfig.model} · concurrency ${opts.concurrency}${c.reset}`,
  );
  console.log(`${c.dim}  dataset → ${opts.dataset}${c.reset}\n`);

  const { loop } = await createAgentLoop(effectiveConfig);
  const runner = new EvalRunner(loop, {
    concurrency: opts.concurrency,
    outputPath,
    defaultScorer: 'contains',
    storage: getStorage(),
  });

  const runStart = Date.now();
  let lastLine = '';
  const stats = await runner.run(tasks, expectedMap, (done, total) => {
    const line = `  ${done}/${total} (${Math.round((done / total) * 100)}%)`;
    process.stdout.write(`\r${line.padEnd(lastLine.length + 2)}`);
    lastLine = line;
  });
  if (lastLine) process.stdout.write('\n');

  // Per-task scores come from the assistant records the runner wrote.
  const results: Array<{ id: string; score: number }> = [];
  try {
    const outSrc = await readFile(outputPath, 'utf-8');
    for (const line of outSrc.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const rec = JSON.parse(trimmed) as { task_id?: string; role?: string; score?: number };
      if (rec.role === 'assistant' && typeof rec.task_id === 'string') {
        results.push({ id: rec.task_id, score: typeof rec.score === 'number' ? rec.score : 0 });
      }
    }
  } catch {
    // Fall back to no per-category detail; overall stats still print below.
  }

  const categories = aggregateByCategory(results);
  const { events, available } = readRepairEvents(runStart);
  const repair = summarizeRepairs(events);

  console.log(`\n${c.bold}Pass rates by category${c.reset}`);
  for (const cat of categories) {
    const pct = Math.round(cat.passRate * 100);
    const colour = cat.passRate >= 1 ? c.green : cat.passRate > 0 ? c.yellow : c.red;
    console.log(
      `  ${cat.category.padEnd(22)} ${colour}${pct}%${c.reset} ${c.dim}(${cat.passed}/${cat.total})${c.reset}`,
    );
  }

  const overallPct = Math.round((stats.avgScore || 0) * 100);
  console.log(
    `\n${c.bold}Overall${c.reset}  ${c.green}${stats.passed} passed${c.reset}` +
      `${stats.failed > 0 ? `  ${c.red}${stats.failed} failed${c.reset}` : ''}` +
      `  ${c.dim}avg ${overallPct}%${c.reset}`,
  );

  console.log(
    `\n${c.bold}Tool-call repair${c.reset} ${c.dim}(this run's tool.repair events)${c.reset}`,
  );
  if (available) {
    const successPct = Math.round(repair.repairSuccessRate * 100);
    console.log(
      `  repaired ${repair.repaired}  ${c.dim}·${c.reset}  failed ${repair.failed}  ${c.dim}·${c.reset}  repair success ${successPct}%`,
    );
  } else {
    console.log(`  ${c.yellow}unavailable — observability store not reachable${c.reset}`);
  }

  console.log(`\n${c.bold}Hard invariants${c.reset}`);
  console.log(
    `  execute-with-{} occurrences: ${repair.executeWithEmptyArgs === 0 ? c.green : c.red}${repair.executeWithEmptyArgs}${c.reset}` +
      `  ${c.dim}(must be 0 — unparseable args become is_error, never a silent {})${c.reset}`,
  );
  const toolCalling = categories.find((cat) => cat.category === 'tool-calling');
  if (toolCalling) {
    const pct = Math.round(toolCalling.passRate * 100);
    console.log(
      `  tool-calling parse-clean rate: ${pct >= 90 ? c.green : c.yellow}${pct}%${c.reset}` +
        `  ${c.dim}(target ≥ 90%; observed via final-answer correctness — the eval harness records text, not per-call parses)${c.reset}`,
    );
  }

  console.log(`\n${c.dim}output → ${outputPath}${c.reset}`);
}
