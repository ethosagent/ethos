// Shebang `#!/usr/bin/env node` is added by tsup via banner config at build time.
// Don't put it here - tsx in dev mode doesn't need it and source-level shebangs
// in TypeScript trip on tsup's bundler.
import { join } from 'node:path';
import { formatError, toEthosError } from '@ethosagent/types';
import { applyCliOverrides, parseCliOverrideFlags } from './cli-overrides';
import { runAcp } from './commands/acp';
import { runArchive } from './commands/archive';
import { runAudit } from './commands/audit';
import { runBackup, runImport } from './commands/backup';
import { runBatch } from './commands/batch';
import { runChat } from './commands/chat';
import { runClaw } from './commands/claw';
import { runCronCommand } from './commands/cron';
import { runData } from './commands/data';
import { runDoctor } from './commands/doctor';
import { runErrors } from './commands/errors';
import { runEval } from './commands/eval';
import { runEvolve } from './commands/evolve';
import { runGatewayStart } from './commands/gateway';
import { runKeys } from './commands/keys';
import { runLogs } from './commands/logs';
import { runMcp } from './commands/mcp';
import { runMeshCommand } from './commands/mesh';
import { runPerf } from './commands/perf';
import { runPlugin } from './commands/plugin';
import { runRetention } from './commands/retention';
import { runSecurityAudit } from './commands/security-audit';
import { runServe } from './commands/serve';
import { runSessionsCommand } from './commands/sessions';
import { runSet } from './commands/set';
import { runSetup } from './commands/setup';
import { runSkills } from './commands/skills';
import { runSupport } from './commands/support';
import { runTail } from './commands/tail';
import { runTeamCommand } from './commands/team';
import { runTrace } from './commands/trace';
import { runUpgrade } from './commands/upgrade';
import { readConfig } from './config';
import { appendErrorLog } from './error-log';
import { getStorage } from './wiring';

// Compile-time injected by tsup via define (or read from env at runtime in dev).
declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

const USAGE =
  'Usage: ethos [setup | chat | sessions | serve | set | team | mesh | logs | gateway | cron | personality | memory | acp | batch | eval | evolve | plugin | skills | keys | claw | doctor | upgrade | mcp | backup | import | trace | audit | security | errors | perf | tail | retention | data | support | archive] [--version | --help]';

const args = process.argv.slice(2);
const command = args[0] ?? '';
const inferredChatFromQueryFlag =
  command === '-q' || command === '--query' || command.startsWith('--query=');
const inferredChatFromResumeFlag =
  command === '--continue' || command === '-c' || command === '--resume' || command === '-r';
const effectiveCommand = inferredChatFromQueryFlag || inferredChatFromResumeFlag ? 'chat' : command;

// FW-8: parse CLI override flags from the full argv. These override
// ~/.ethos/config.yaml for this invocation only and are never written back.
const cliOverrideFlags = parseCliOverrideFlags(args);

function extractSingleQuery(argv: string[]): {
  query?: string;
  rest: string[];
  queryFlagUsed: boolean;
} {
  const rest: string[] = [];
  let query: string | undefined;
  let queryFlagUsed = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '-q' || a === '--query') {
      queryFlagUsed = true;
      query = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--query=')) {
      queryFlagUsed = true;
      query = a.slice('--query='.length);
      continue;
    }
    rest.push(a);
  }
  return { query, rest, queryFlagUsed };
}

try {
  switch (effectiveCommand) {
    case '--version':
    case '-v': {
      console.log(`@ethosagent/cli ${ETHOS_VERSION}`);
      break;
    }

    case '--help':
    case '-h': {
      console.log(USAGE);
      break;
    }

    case 'setup': {
      const setupSub = args[1];
      const sectionStepMap: Record<string, import('@ethosagent/tui/setup').WizardStepId> = {
        auth: 'auth',
        model: 'model',
        personality: 'personality',
        messaging: 'messaging',
        memory: 'memory',
        providers: 'provider-chain',
        keys: 'key-rotation',
      };
      const startAtStep = setupSub ? sectionStepMap[setupSub] : undefined;
      const setupResult = await runSetup(startAtStep);
      if (setupResult?.launchChat) {
        await runChat(setupResult.config);
      }
      break;
    }

    case 'chat':
    case '': {
      const chatArgs = args.slice(command === 'chat' ? 1 : 0);
      const verboseFlag = chatArgs.includes('--verbose');
      // --skin <name> overrides the persisted config.skin for this process.
      const skinFlagIdx = chatArgs.indexOf('--skin');
      const skinFlag = skinFlagIdx !== -1 ? chatArgs[skinFlagIdx + 1] : undefined;
      // --team <name> overrides activeContext for this process (no persistence).
      // Mirrors `ethos serve --team`; same dispatch as `ethos set team <name>`.
      const teamFlagIdx = chatArgs.indexOf('--team');
      const teamFlag = teamFlagIdx !== -1 ? chatArgs[teamFlagIdx + 1] : undefined;
      if (teamFlagIdx !== -1 && (!teamFlag || teamFlag.startsWith('--'))) {
        console.error('Usage: ethos chat --team <name>');
        process.exit(1);
      }
      // FW-2 — --continue / -c (resume most recent) and --resume / -r <id> (resume by id/title)
      const continueFlag = chatArgs.includes('--continue') || chatArgs.includes('-c');
      const resumeFlagIdx =
        chatArgs.indexOf('--resume') !== -1 ? chatArgs.indexOf('--resume') : chatArgs.indexOf('-r');
      const resumeQuery = resumeFlagIdx !== -1 ? chatArgs[resumeFlagIdx + 1] : undefined;
      // FW-5 — --no-resume-hint suppresses the exit hint for this session
      const noResumeHintFlag = chatArgs.includes('--no-resume-hint');

      const { query, queryFlagUsed } = extractSingleQuery(chatArgs);
      if (queryFlagUsed && (!query || query.trim().length === 0)) {
        console.error('Usage: ethos chat -q "<prompt>"');
        process.exit(1);
      }

      // Resolve resume target before loading config so we can error early
      let resumeSessionKey: string | undefined;
      let resumeSessionId: string | undefined;
      if (continueFlag || resumeQuery !== undefined) {
        const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
        const { ethosDir } = await import('./config');
        const { join: pathJoin } = await import('node:path');
        const { resolveResumeSession } = await import('./commands/sessions');
        const store = new SQLiteSessionStore(pathJoin(ethosDir(), 'sessions.db'));
        try {
          const target = continueFlag
            ? { type: 'continue' as const }
            : { type: 'resume' as const, query: resumeQuery ?? '' };
          const session = await resolveResumeSession(store, target);
          if (!session) {
            console.error(
              continueFlag ? 'No sessions found to resume.' : `Session not found: ${resumeQuery}`,
            );
            process.exit(1);
          }
          resumeSessionKey = session.key;
          resumeSessionId = session.id;
        } finally {
          store.close();
        }
      }

      const config = await readConfig(getStorage());
      if (!config) {
        console.log('No config found. Running setup first...\n');
        const setupResult = await runSetup();
        if (setupResult) {
          const { config: fresh } = setupResult;
          let withFlags = { ...fresh };
          if (verboseFlag) withFlags.verbose = true;
          if (skinFlag) withFlags.skin = skinFlag;
          if (teamFlag) withFlags.activeContext = { type: 'team', name: teamFlag };
          // FW-8: apply CLI overrides after config is available.
          withFlags = await applyCliOverrides(withFlags, cliOverrideFlags, getStorage());
          await runChat(withFlags, {
            ...(query ? { singleQuery: query } : {}),
            ...(resumeSessionKey ? { resumeSessionKey, resumeSessionId } : {}),
            ...(noResumeHintFlag ? { noResumeHint: true } : {}),
          });
          if (query) process.exit(0);
        }
      } else {
        let withFlags = { ...config };
        if (verboseFlag) withFlags.verbose = true;
        if (skinFlag) withFlags.skin = skinFlag;
        if (teamFlag) withFlags.activeContext = { type: 'team', name: teamFlag };
        // FW-8: apply CLI overrides after config is available.
        withFlags = await applyCliOverrides(withFlags, cliOverrideFlags, getStorage());
        await runChat(withFlags, {
          ...(query ? { singleQuery: query } : {}),
          ...(resumeSessionKey ? { resumeSessionKey, resumeSessionId } : {}),
          ...(noResumeHintFlag ? { noResumeHint: true } : {}),
        });
        if (query) process.exit(0);
      }
      break;
    }

    case 'sessions': {
      await runSessionsCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'personality': {
      const sub = args[1] ?? '';
      if (sub === 'list' || sub === '') {
        const { createPersonalityRegistry } = await import('@ethosagent/personalities');
        const reg = await createPersonalityRegistry();
        console.log('\nBuilt-in personalities:\n');
        for (const p of reg.list()) {
          const def = reg.getDefault().id === p.id ? ' (default)' : '';
          console.log(`  ${p.id.padEnd(14)} ${p.description ?? ''}${def}`);
        }
        console.log();
      } else if (sub === 'set' && args[2]) {
        const { writeConfig, readConfig: rc } = await import('./config');
        const cfg = await rc(getStorage());
        if (!cfg) {
          console.error('Run ethos setup first.');
          process.exit(1);
        }
        await writeConfig(getStorage(), { ...cfg, personality: args[2] });
        console.log(`Personality set to: ${args[2]}`);
      } else if (sub === 'mcp') {
        await runPersonalityMcp(args.slice(2));
      } else if (sub === 'plugins') {
        await runPersonalityPlugins(args.slice(2));
      } else if (sub === 'duplicate') {
        await runPersonalityDuplicate(args.slice(2));
      } else if (sub === 'skin') {
        const { runPersonalitySkin } = await import('./commands/personality-skin');
        await runPersonalitySkin(args.slice(2));
      } else {
        console.log(
          'Usage: ethos personality [list | set <id> | duplicate <src> <dst> | mcp <id> [--attach <name> | --detach <name>] | plugins <id> [--attach <plugin-id> | --detach <plugin-id>] | skin [<id> [<name> | --clear]]]',
        );
      }
      break;
    }

    case 'plugins': {
      await runPluginsStatus();
      break;
    }

    case 'memory': {
      const sub = args[1] ?? 'show';
      const config = await readConfig(getStorage());

      if (config?.memory === 'vector') {
        const { VectorMemoryProvider } = await import('@ethosagent/memory-vector');
        const { ethosDir: getDir } = await import('./config');
        const mem = new VectorMemoryProvider({ dir: getDir() });

        if (sub === 'show' || sub === '') {
          const records = mem.showRecent(20);
          if (records.length === 0) {
            console.log('No memory yet.');
          } else {
            for (const r of records) {
              console.log(`[${r.scopeId}/${r.key}] ${r.createdAt.toISOString().slice(0, 16)}`);
              console.log(r.content);
              console.log();
            }
          }
        } else if (sub === 'add') {
          const text = args.slice(2).join(' ');
          if (!text) {
            console.error('Usage: ethos memory add "<text>"');
            process.exit(1);
          }
          const n = await mem.add(text, 'memory');
          console.log(`Added ${n} chunk${n === 1 ? '' : 's'} to vector memory.`);
        } else if (sub === 'export') {
          const { join: pathJoin } = await import('node:path');
          const outPath = args[2] ?? pathJoin(getDir(), `memory-export-${Date.now()}.md`);
          const n = await mem.exportAll(outPath);
          if (n === 0) {
            console.log('Memory is empty - nothing to export.');
          } else {
            console.log(`Exported ${n} chunk${n === 1 ? '' : 's'} to ${outPath}`);
          }
        } else if (sub === 'clear') {
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await new Promise<void>((resolve) => {
            rl.question('Clear all vector memory? This cannot be undone. [y/N] ', (answer) => {
              rl.close();
              if (answer.toLowerCase() === 'y') {
                mem.clear();
                console.log('Vector memory cleared.');
              } else {
                console.log('Cancelled.');
              }
              resolve();
            });
          });
        } else {
          console.log('Usage: ethos memory [show | add "<text>" | export [path] | clear]');
        }
        mem.close();
      } else {
        const { createMemoryProvider } = await import('@ethosagent/wiring');
        const { ethosDir: getDir } = await import('./config');
        const mem = createMemoryProvider({ dataDir: getDir() });
        const cliCtx = {
          scopeId: 'global',
          sessionId: '',
          sessionKey: 'cli',
          platform: 'cli',
          workingDir: process.cwd(),
        };

        if (sub === 'show' || sub === '') {
          const result = await mem.prefetch(cliCtx);
          if (result && result.entries.length > 0) {
            console.log(result.entries.map((e) => e.content.trim()).join('\n\n'));
          } else {
            console.log('No memory yet.');
          }
        } else if (sub === 'add') {
          const text = args.slice(2).join(' ');
          if (!text) {
            console.error('Usage: ethos memory add "<text>"');
            process.exit(1);
          }
          await mem.sync([{ action: 'add', key: 'MEMORY.md', content: text }], cliCtx);
          console.log('Added to memory.');
        } else if (sub === 'clear') {
          await mem.sync([{ action: 'replace', key: 'MEMORY.md', content: '' }], cliCtx);
          console.log('Memory cleared.');
        } else {
          console.log('Usage: ethos memory [show | add "<text>" | clear]');
        }
      }
      break;
    }

    case 'gateway': {
      const sub = args[1] ?? '';
      if (sub === 'setup') {
        // Alias: open the TUI wizard at the messaging step (TTY), else legacy readline setup.
        const gwResult = await runSetup('messaging');
        if (gwResult?.launchChat) await runChat(gwResult.config);
      } else if (sub === 'start') {
        await runGatewayStart();
      } else {
        console.log('Usage: ethos gateway [setup | start]');
      }
      break;
    }

    case 'cron': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runCronCommand(args[1] ?? 'list', args.slice(2), config);
      break;
    }

    case 'acp': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runAcp(config);
      break;
    }

    case 'serve': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runServe(args.slice(1), config);
      break;
    }

    case 'batch': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runBatch(args.slice(1), config);
      break;
    }

    case 'eval': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runEval(args.slice(1), config);
      break;
    }

    case 'evolve': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runEvolve(args.slice(1), config);
      break;
    }

    case 'plugin': {
      await runPlugin(args.slice(1));
      break;
    }

    case 'skills': {
      await runSkills(args.slice(1));
      break;
    }

    case 'keys': {
      await runKeys(args.slice(1));
      break;
    }

    case 'claw': {
      await runClaw(args.slice(1));
      break;
    }

    case 'doctor': {
      await runDoctor(args.slice(1));
      break;
    }

    case 'upgrade': {
      await runUpgrade();
      break;
    }

    case 'set': {
      await runSet(args.slice(1));
      break;
    }

    case 'team': {
      await runTeamCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'mesh': {
      await runMeshCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'logs': {
      await runLogs(args.slice(1));
      break;
    }

    case 'mcp': {
      await runMcp(args.slice(1));
      break;
    }

    case 'backup': {
      await runBackup(args.slice(1));
      break;
    }

    case 'import': {
      await runImport(args.slice(1));
      break;
    }

    case 'trace': {
      await runTrace(args.slice(1));
      break;
    }

    case 'audit': {
      await runAudit(args.slice(1));
      break;
    }

    case 'security': {
      // `ethos security audit [--fix] [--json] [--deep]`
      if (args[1] !== 'audit') {
        console.error('Usage: ethos security audit [--fix] [--json] [--deep]');
        process.exit(2);
      }
      await runSecurityAudit(args.slice(1));
      break;
    }

    case 'errors': {
      await runErrors(args.slice(1));
      break;
    }

    case 'perf': {
      await runPerf(args.slice(1));
      break;
    }

    case 'tail': {
      await runTail(args.slice(1));
      break;
    }

    case 'retention': {
      await runRetention(args[1] ?? 'show', args.slice(2));
      break;
    }

    case 'data': {
      await runData(args[1] ?? 'stats', args.slice(2));
      break;
    }

    case 'support': {
      await runSupport(args[1] ?? 'bundle', args.slice(2));
      break;
    }

    case 'archive': {
      await runArchive(args[1] ?? 'list', args.slice(2));
      break;
    }

    // Internal command - launched by `ethos team start` as a detached background
    // supervisor process. Not listed in USAGE; not user-facing.
    case '_supervisor': {
      const teamName = args[1];
      const manifestPath = args[2];
      if (!teamName || !manifestPath) {
        console.error('_supervisor requires <name> <manifestPath>');
        process.exit(1);
      }
      const { readFileSync } = await import('node:fs');
      const { ConsoleLogger } = await import('@ethosagent/logger');
      const { parseTeamManifest, runSupervisor } = await import('@ethosagent/team-supervisor');
      const supervisorLogger = new ConsoleLogger();
      const manifest = parseTeamManifest(readFileSync(manifestPath, 'utf-8'), {
        logger: supervisorLogger,
      });
      await runSupervisor(manifest, manifestPath, { logger: supervisorLogger });
      break;
    }

    default:
      console.log(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  // Phase 30.9 - render every surface-level failure through the EthosError
  // envelope so users see code/cause/action even when a command throws raw.
  const e = toEthosError(err);
  process.stderr.write(`\n${formatError(e, { color: process.stderr.isTTY })}\n`);
  // Phase 30.10 - append to ~/.ethos/logs/errors.jsonl for local diagnostics.
  appendErrorLog(e, { command: effectiveCommand });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ethos personality mcp <id> [--attach <name> | --detach <name>]
// ---------------------------------------------------------------------------

async function runPersonalityMcp(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.log('Usage: ethos personality mcp <id> [--attach <name> | --detach <name>]');
    return;
  }
  const flags = parseCliFlags(argv.slice(1));
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { loadMcpConfig } = await import('@ethosagent/tools-mcp');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const personality = reg.get(id);
  if (!personality) {
    console.error(`Unknown personality: ${id}`);
    process.exit(1);
  }

  const allServers = await loadMcpConfig(storage);
  const attached = new Set(personality.mcp_servers ?? []);

  if (flags.attach) {
    attached.add(flags.attach);
    await reg.update(id, { mcp_servers: [...attached] });
    console.log(`✓ Attached MCP server "${flags.attach}" to ${id}`);
    return;
  }
  if (flags.detach) {
    attached.delete(flags.detach);
    await reg.update(id, { mcp_servers: [...attached] });
    console.log(`✓ Detached MCP server "${flags.detach}" from ${id}`);
    return;
  }

  console.log(`\nMCP servers for ${id}:\n`);
  if (allServers.length === 0) {
    console.log('  No MCP servers configured in ~/.ethos/mcp.json');
  } else {
    for (const s of allServers) {
      const mark = attached.has(s.name) ? '✓' : ' ';
      console.log(`  [${mark}] ${s.name}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// ethos personality plugins <id> [--attach <plugin-id> | --detach <plugin-id>]
// ---------------------------------------------------------------------------

async function runPersonalityPlugins(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.log(
      'Usage: ethos personality plugins <id> [--attach <plugin-id> | --detach <plugin-id>]',
    );
    return;
  }
  const flags = parseCliFlags(argv.slice(1));
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { scanInstalledPlugins } = await import('@ethosagent/plugin-loader');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const personality = reg.get(id);
  if (!personality) {
    console.error(`Unknown personality: ${id}`);
    process.exit(1);
  }

  const allPlugins = await scanInstalledPlugins({ userDir: ethosDir(), storage });
  const attached = new Set(personality.plugins ?? []);

  if (flags.attach) {
    attached.add(flags.attach);
    await reg.update(id, { plugins: [...attached] });
    console.log(`✓ Attached plugin "${flags.attach}" to ${id}`);
    return;
  }
  if (flags.detach) {
    attached.delete(flags.detach);
    await reg.update(id, { plugins: [...attached] });
    console.log(`✓ Detached plugin "${flags.detach}" from ${id}`);
    return;
  }

  console.log(`\nPlugins for ${id}:\n`);
  if (allPlugins.length === 0) {
    console.log('  No plugins installed. Run: ethos plugin install <path>');
  } else {
    for (const p of allPlugins) {
      const mark = attached.has(p.id) ? '✓' : ' ';
      console.log(`  [${mark}] ${p.id.padEnd(24)} ${p.description ?? ''}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// ethos personality duplicate <src> <dst>
// ---------------------------------------------------------------------------

async function runPersonalityDuplicate(argv: string[]): Promise<void> {
  const src = argv[0];
  const dst = argv[1];
  if (!src || !dst) {
    console.log('Usage: ethos personality duplicate <src-id> <dst-id>');
    return;
  }
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const created = await reg.duplicate(src, dst);
  const newId = created.config.id;
  console.log(`✓ Duplicated "${src}" -> "${newId}" at ~/.ethos/personalities/${newId}`);
}

// ---------------------------------------------------------------------------
// ethos plugins status - global plugin × personality matrix
// ---------------------------------------------------------------------------

async function runPluginsStatus(): Promise<void> {
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { scanInstalledPlugins } = await import('@ethosagent/plugin-loader');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const allPlugins = await scanInstalledPlugins({ userDir: ethosDir(), storage });
  const allPersonalities = reg.list();

  if (allPlugins.length === 0) {
    console.log('\nNo plugins installed. Run: ethos plugin install <path>\n');
    return;
  }

  console.log('\nPlugin attachment status:\n');
  const colWidth = 20;
  const header = 'Plugin'.padEnd(colWidth) + allPersonalities.map((p) => p.id.padEnd(12)).join('');
  console.log(`  ${header}`);
  console.log(`  ${'-'.repeat(header.length)}`);

  for (const plugin of allPlugins) {
    let row = plugin.id.padEnd(colWidth);
    for (const personality of allPersonalities) {
      const attached = (personality.plugins ?? []).includes(plugin.id);
      row += (attached ? '✓' : '·').padEnd(12);
    }
    console.log(`  ${row}`);
  }
  console.log();

  const unattached = allPlugins.filter((p) =>
    allPersonalities.every((pers) => !(pers.plugins ?? []).includes(p.id)),
  );
  if (unattached.length > 0) {
    console.log(
      `  ⚠  ${unattached.length} plugin(s) installed but not attached to any personality - they're inert until attached.`,
    );
    console.log();
  }
}

function parseCliFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}
