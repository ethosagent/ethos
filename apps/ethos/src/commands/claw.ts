import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ClawMigrator, type MigrateOptions, type MigrationPlan } from '@ethosagent/claw-migrate';
import { readConfig } from '@ethosagent/config';
import { refuseJson, splitJson, writeJson, writeJsonError } from '../json-output';
import { openFileMemory } from '../lib/file-memory';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

interface ParsedFlags {
  dryRun: boolean;
  preset: 'all' | 'user-data';
  overwrite: boolean;
  yes: boolean;
}

/** The per-item outcomes of a plan that had nothing to execute. */
const NOTHING_RAN = { copied: 0, skipped: 0, failed: 0, items: [] };

export async function runClaw(args: string[]): Promise<void> {
  const { json, args: argv } = splitJson(args);
  const sub = argv[0] ?? '';
  if (sub !== 'migrate') {
    const usage =
      'Usage: ethos claw migrate [--dry-run] [--preset user-data] [--overwrite] [--yes] [--json]';
    if (json) writeJsonError('INVALID_INPUT', usage);
    console.log(usage);
    process.exit(sub === '' ? 0 : 1);
  }

  const flags = parseFlags(argv.slice(1), json);
  // The imported MEMORY.md / USER.md go to the scope of the TARGET's configured
  // memory backend (F04): the vault under `memory: vault`, the personality's own
  // directory under markdown. `openFileMemory` refuses a backend with no file
  // memory (vector) rather than importing into files no agent reads — the CLI's
  // top-level handler renders that as NOT_CONFIGURED with the next step.
  const config = await readConfig(getStorage(), await getSecretsResolver());
  const memoryDir = config
    ? join(
        openFileMemory(config, 'tool').memoryRoot,
        'personalities',
        config.personality ?? 'default',
      )
    : undefined;
  const opts: MigrateOptions = {
    storage: getStorage(),
    dryRun: flags.dryRun,
    preset: flags.preset,
    overwrite: flags.overwrite,
    ...(memoryDir ? { memoryDir } : {}),
  };

  const migrator = new ClawMigrator(opts);

  if (!(await migrator.sourceExists())) {
    if (json) {
      writeJsonError(
        'FILE_NOT_FOUND',
        `No OpenClaw install found at ${migrator.source}. Looking for ${migrator.source}/config.yaml — exiting without changes.`,
      );
    }
    console.error(
      `${c.red}No OpenClaw install found at ${migrator.source}.${c.reset}\n${c.dim}Looking for ${migrator.source}/config.yaml — exiting without changes.${c.reset}`,
    );
    process.exit(1);
  }

  const plan = await migrator.plan();
  if (!json) printPlanSummary(plan, flags);

  // The document echoes the plan, then the per-item outcomes (empty when nothing ran).
  const document = (result: Awaited<ReturnType<ClawMigrator['execute']>> | typeof NOTHING_RAN) => ({
    ok: true,
    dryRun: flags.dryRun,
    preset: flags.preset,
    overwrite: flags.overwrite,
    plan: {
      source: plan.source,
      target: plan.target,
      workspace: plan.workspace,
      summary: plan.summary,
      personality: plan.personality,
      ops: plan.ops,
    },
    copied: result.copied,
    skipped: result.skipped,
    failed: result.failed,
    items: result.items,
  });

  if (plan.ops.length === 0) {
    if (json) {
      writeJson(document(NOTHING_RAN));
      return;
    }
    console.log(`${c.yellow}Nothing to migrate.${c.reset}`);
    return;
  }

  if (!flags.dryRun && !flags.yes) {
    refuseJson(
      args,
      '`ethos claw migrate` asks before writing; pass --yes (or --dry-run) with --json.',
    );
    const ok = await confirm(`${c.bold}Proceed with migration?${c.reset} [y/N] `);
    if (!ok) {
      console.log(`${c.dim}Cancelled.${c.reset}`);
      return;
    }
  }

  const result = await migrator.execute(plan);

  if (json) {
    writeJson(document(result));
    return;
  }

  console.log();
  for (const item of result.items) {
    if (item.status === 'copied') {
      const verb = flags.dryRun ? 'would copy' : 'copied';
      console.log(`  ${c.green}✓ ${verb}${c.reset}  ${item.label}`);
    } else if (item.status === 'skipped') {
      console.log(
        `  ${c.yellow}⚠ skipped${c.reset}  ${item.label}${c.dim}  (${item.reason ?? 'unknown'})${c.reset}`,
      );
    } else {
      console.log(
        `  ${c.red}✗ failed${c.reset}   ${item.label}${c.dim}  (${item.reason ?? 'unknown'})${c.reset}`,
      );
    }
  }

  console.log();
  if (flags.dryRun) {
    console.log(
      `${c.dim}Dry run — no files written. Re-run without --dry-run to migrate.${c.reset}`,
    );
    return;
  }
  if (result.failed > 0) {
    console.log(
      `${c.yellow}Migration finished with ${result.failed} failure${result.failed === 1 ? '' : 's'}.${c.reset}`,
    );
  } else {
    console.log(
      `${c.green}Migration complete.${c.reset} Run \`ethos setup\` to verify your config.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args: string[], json: boolean): ParsedFlags {
  let dryRun = false;
  let preset: 'all' | 'user-data' = 'all';
  let overwrite = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--overwrite') overwrite = true;
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--preset') {
      const next = args[i + 1];
      if (next === 'user-data' || next === 'all') {
        preset = next;
        i += 1;
      } else {
        if (json)
          writeJsonError('INVALID_INPUT', `Unknown preset: ${next}. Valid: 'all' | 'user-data'.`);
        console.error(`Unknown preset: ${next}. Valid: 'all' | 'user-data'.`);
        process.exit(1);
      }
    } else {
      if (json) writeJsonError('INVALID_INPUT', `Unknown flag: ${a}`);
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return { dryRun, preset, overwrite, yes };
}

function printPlanSummary(plan: MigrationPlan, flags: ParsedFlags): void {
  console.log(`\n${c.bold}OpenClaw → Ethos migration plan${c.reset}`);
  console.log(`${c.dim}  source: ${c.reset}${plan.source}`);
  console.log(`${c.dim}  target: ${c.reset}${plan.target}`);
  if (plan.detected.agents) console.log(`${c.dim}  workspace: ${c.reset}${plan.workspace}`);
  console.log(
    `${c.dim}  preset: ${c.reset}${flags.preset}${flags.overwrite ? ` ${c.yellow}(--overwrite)${c.reset}` : ''}`,
  );
  console.log();
  console.log(
    `${c.dim}  ${plan.summary.memories} memory file${plural(plan.summary.memories)}, ${plan.summary.skills} skill${plural(plan.summary.skills)}, ${plan.summary.platformTokens} platform token${plural(plan.summary.platformTokens)}, ${plan.summary.apiKeys} API key${plural(plan.summary.apiKeys)}${c.reset}`,
  );
  if (plan.personality.becomesMigrated) {
    console.log(
      `${c.dim}  personality: ${c.reset}${c.cyan}migrated${c.reset}${c.dim} (from SOUL.md${plan.personality.requested ? `, was \`${plan.personality.requested}\`` : ''})${c.reset}`,
    );
  } else if (plan.personality.requested) {
    console.log(`${c.dim}  personality: ${c.reset}${c.cyan}${plan.personality.resolved}${c.reset}`);
  }
  console.log();
  console.log(`${c.bold}Operations:${c.reset}`);
  for (const op of plan.ops) {
    console.log(`  ${c.cyan}${op.kind.padEnd(22)}${c.reset} ${op.label}`);
  }
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}
