import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { MemberRuntime } from '@ethosagent/team-supervisor';
import {
  parseTeamManifest,
  readRuntime,
  removeRuntime,
  teamsDir,
  validateForStart,
} from '@ethosagent/team-supervisor';
import type { TeamManifest } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { runtimeHealth } from './team-runtime';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

function resolveManifestPath(name: string): string {
  // Project-scoped: ./team.yaml, only when name matches.
  const local = resolvePath('./team.yaml');
  try {
    const src = readFileSync(local, 'utf-8');
    const m = parseTeamManifest(src);
    if (m.name === name) return local;
  } catch {
    /* not present or name mismatch */
  }

  const user = join(teamsDir(), `${name}.yaml`);
  if (existsSync(user)) return user;

  throw new EthosError({
    code: 'FILE_NOT_FOUND',
    cause: `No team manifest found for "${name}"`,
    action: `Create one with: ethos team create ${name}`,
  });
}

// ---------------------------------------------------------------------------
// YAML serialiser (hand-written — avoids adding yaml dep to the CLI)
// ---------------------------------------------------------------------------

function serializeTeamManifest(manifest: TeamManifest): string {
  const lines: string[] = [
    `name: ${manifest.name}`,
    `description: ${manifest.description || `${manifest.name} team`}`,
  ];

  if (manifest.domain_capabilities.length === 0) {
    lines.push('domain_capabilities: []');
  } else {
    lines.push('domain_capabilities:');
    for (const cap of manifest.domain_capabilities) lines.push(`  - ${cap}`);
  }

  if (manifest.dispatch_mode) lines.push(`dispatch_mode: ${manifest.dispatch_mode}`);
  if (manifest.coordinator) lines.push(`coordinator: ${manifest.coordinator}`);
  if (manifest.coordinator_model) lines.push(`coordinator_model: ${manifest.coordinator_model}`);
  if (manifest.personality_models && Object.keys(manifest.personality_models).length > 0) {
    lines.push('personality_models:');
    for (const [id, model] of Object.entries(manifest.personality_models)) {
      lines.push(`  ${id}: ${model}`);
    }
  }
  if (manifest.mesh) lines.push(`mesh: ${manifest.mesh}`);

  if (manifest.members.length === 0) {
    lines.push('members: []');
  } else {
    lines.push('members:');
    for (const m of manifest.members) {
      lines.push(`  - personality: ${m.personality}`);
      if (m.auto_restart !== undefined) lines.push(`    auto_restart: ${m.auto_restart}`);
      if (m.port !== undefined) lines.push(`    port: ${m.port}`);
      if (m.capabilities?.length) {
        lines.push('    capabilities:');
        for (const cap of m.capabilities) lines.push(`      - ${cap}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runTeamList(args: string[] = []): Promise<void> {
  const jsonMode = args.includes('--json');
  const dir = teamsDir();
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') && !f.endsWith('.runtime.yaml'))
      .sort();
  } catch {
    /* directory doesn't exist yet */
  }

  if (files.length === 0) {
    if (jsonMode) {
      writeJson([]);
      return;
    }
    console.log(`${c.dim}No teams found. Create one at ~/.ethos/teams/<name>.yaml${c.reset}`);
    return;
  }

  if (jsonMode) {
    const result = files.map((file) => {
      const teamName = basename(file, '.yaml');
      const rt = readRuntime(teamName);
      const health = runtimeHealth(rt);
      if (health === 'stale') removeRuntime(teamName);
      const liveRt = health === 'running' ? rt : null;
      const liveMembers = liveRt?.members.filter(
        (m) => m.status !== 'stopped' && m.status !== 'failed',
      );
      return {
        name: teamName,
        status: (liveMembers?.length ?? 0) > 0 ? 'running' : 'stopped',
        members: liveMembers?.length ?? 0,
      };
    });
    writeJson(result);
    return;
  }

  console.log(`\n${c.bold}Teams:${c.reset}\n`);
  for (const file of files) {
    const teamName = basename(file, '.yaml');
    const rt = readRuntime(teamName);
    const health = runtimeHealth(rt);
    if (health === 'stale') removeRuntime(teamName);
    const liveRt = health === 'running' ? rt : null;
    const liveMembers = liveRt?.members.filter(
      (m) => m.status !== 'stopped' && m.status !== 'failed',
    );
    const isRunning = (liveMembers?.length ?? 0) > 0;
    const status = isRunning ? `${c.green}running${c.reset}` : `${c.dim}stopped${c.reset}`;
    const memberCount = liveMembers?.length ?? 0;
    const members = isRunning ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : '';
    console.log(
      `  ${c.bold}${teamName.padEnd(20)}${c.reset} ${status}  ${c.dim}${members}${c.reset}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function runTeamStart(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team start <name>');
    process.exit(1);
  }

  const manifestPath = resolveManifestPath(name);
  const src = readFileSync(manifestPath, 'utf-8');
  const manifest = parseTeamManifest(src);
  validateForStart(manifest);

  const existingRuntime = readRuntime(name);
  const existingHealth = runtimeHealth(existingRuntime);
  if (existingHealth === 'running') {
    console.error(
      `Team ${name} already running (PID ${existingRuntime?.supervisorPid}). Use 'ethos team status ${name}' for details.`,
    );
    process.exit(1);
  }
  if (existingHealth === 'stale') {
    removeRuntime(name);
    console.log(`${c.yellow}Cleaning up stale runtime state before start.${c.reset}`);
  }

  console.log(
    `\n${c.bold}Starting team "${manifest.name}"${c.reset} (${manifest.members.length} members)`,
  );

  // Spawn the supervisor as a detached background process.
  // In source mode (`tsx apps/ethos/src/index.ts ...`), Node cannot execute
  // TypeScript directly, so we must re-launch with `--import tsx`.
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    throw new EthosError({
      code: 'INTERNAL',
      cause: 'Cannot determine CLI entry point for team supervisor launch',
      action: 'Re-run `ethos team start <name>`; if it repeats, file an issue.',
    });
  }
  const launchArgs = buildSupervisorLaunchArgs(entryPoint, name, manifestPath);

  const child = spawn(process.execPath, launchArgs, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const pid = child.pid;

  // Brief wait so the supervisor has time to write its PID file.
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  const rt = readRuntime(name);
  if (rt) {
    console.log(`Supervisor PID: ${rt.supervisorPid}`);
    console.log(`\n${c.bold}Members:${c.reset}`);
    for (const m of rt.members) {
      console.log(`  ${m.personality.padEnd(20)} port ${m.port}`);
    }
    console.log(`\n${c.dim}Use 'ethos team status ${name}' to check health.${c.reset}`);
  } else {
    // Fallback if supervisor hasn't written runtime yet.
    console.log(`Supervisor spawned (PID ${pid ?? '?'})`);
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function runTeamStop(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team stop <name>');
    process.exit(1);
  }

  const rt = readRuntime(name);
  const rtHealth = runtimeHealth(rt);
  if (rtHealth === 'missing') {
    console.error(`Team "${name}" does not appear to be running (no runtime file).`);
    process.exit(1);
  }

  if (rtHealth === 'stale') {
    removeRuntime(name);
    console.error(`Team "${name}" is already stopped (stale runtime cleaned up).`);
    process.exit(1);
  }

  if (!rt) {
    throw new EthosError({
      code: 'INTERNAL',
      cause: `Runtime unexpectedly missing for team "${name}" after liveness checks`,
      action: `Re-run 'ethos team stop ${name}'. If this repeats, file an issue.`,
    });
  }

  const { supervisorPid } = rt;
  try {
    process.kill(supervisorPid, 'SIGTERM');
    console.log(
      `Sent SIGTERM to supervisor (PID ${supervisorPid}). Team "${name}" is shutting down.`,
    );
    console.log(
      `${c.dim}Use 'ethos team status ${name}' to confirm all members have stopped.${c.reset}`,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      console.error(`Supervisor PID ${supervisorPid} not found — team may have already stopped.`);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// destroy — wipe the team directory including the board (irreversible)
// ---------------------------------------------------------------------------

// Allowed characters mirror what `ethos team create` accepts: letters, digits,
// dashes, dots, underscores. Crucially: no path separators, no `.`/`..` alone.
// Without this check, `ethos team destroy .. --yes` would resolve `teamDir` to
// the parent of `teamsDir()` and `rmSync(recursive)` would wipe far beyond one
// team. Fail-closed here.
const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeTeamName(name: string): void {
  if (name === '.' || name === '..' || !TEAM_NAME_PATTERN.test(name)) {
    console.error(
      `Invalid team name "${name}". Allowed: letters, digits, dashes, dots, underscores; no path separators; cannot be "." or "..".`,
    );
    process.exit(1);
  }
}

async function runTeamDestroy(name: string | undefined, args: string[]): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team destroy <name> [--yes]');
    process.exit(1);
  }
  assertSafeTeamName(name);

  const rt = readRuntime(name);
  if (runtimeHealth(rt) === 'running') {
    console.error(
      `Team "${name}" is still running. Stop it first: ${c.cyan}ethos team stop ${name}${c.reset}`,
    );
    process.exit(1);
  }

  const teamDir = join(teamsDir(), name);
  const manifestFile = join(teamsDir(), `${name}.yaml`);
  const teamDirExists = existsSync(teamDir);
  const manifestExists = existsSync(manifestFile);
  if (!teamDirExists && !manifestExists) {
    console.error(`No team data found for "${name}".`);
    process.exit(1);
  }

  const yes = args.includes('--yes') || args.includes('-y');
  if (!yes) {
    console.log(`This will ${c.red}permanently delete${c.reset}:`);
    if (manifestExists) console.log(`  - ${manifestFile}`);
    if (teamDirExists) console.log(`  - ${teamDir} (logs, runtime, kanban board.db)`);
    console.log('');
    console.log(`Re-run with ${c.bold}--yes${c.reset} to confirm.`);
    process.exit(1);
  }

  if (manifestExists) rmSync(manifestFile);
  if (teamDirExists) rmSync(teamDir, { recursive: true, force: true });
  console.log(`Team "${name}" destroyed.`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function statusColor(status: MemberRuntime['status']): string {
  switch (status) {
    case 'running':
      return c.green;
    case 'restarting':
      return c.yellow;
    case 'failed':
      return c.red;
    case 'stopped':
      return c.dim;
    default:
      return c.dim;
  }
}

async function runTeamStatus(name: string | undefined, args: string[] = []): Promise<void> {
  const jsonMode = args.includes('--json');
  const effectiveName = name === '--json' ? undefined : name;
  if (!effectiveName) {
    console.error('Usage: ethos team status <name>');
    process.exit(1);
  }

  const rt = readRuntime(effectiveName);
  const rtHealth = runtimeHealth(rt);
  if (rtHealth === 'missing') {
    if (jsonMode) {
      writeJson({ name: effectiveName, status: 'stopped', members: [] });
      return;
    }
    console.log(`Team "${effectiveName}": ${c.dim}stopped${c.reset} (no runtime file)`);
    return;
  }

  if (rtHealth === 'stale') {
    removeRuntime(effectiveName);
    if (jsonMode) {
      writeJson({ name: effectiveName, status: 'stopped', members: [] });
      return;
    }
    console.log(`Team "${effectiveName}": ${c.dim}stopped${c.reset} (cleaned stale runtime)`);
    return;
  }

  if (!rt) {
    throw new EthosError({
      code: 'INTERNAL',
      cause: `Runtime unexpectedly missing for team "${effectiveName}" after liveness checks`,
      action: `Re-run 'ethos team status ${effectiveName}'. If this repeats, file an issue.`,
    });
  }

  if (jsonMode) {
    const members = rt.members.map((m) => ({
      personality: m.personality,
      port: m.port,
      status: m.status,
      pid: m.pid ?? null,
      failureCount: m.failureCount,
    }));
    writeJson({
      name: rt.name,
      supervisorPid: rt.supervisorPid,
      startedAt: rt.startedAt,
      uptimeSeconds: Math.floor((Date.now() - new Date(rt.startedAt).getTime()) / 1000),
      members,
    });
    return;
  }

  const uptime = Math.floor((Date.now() - new Date(rt.startedAt).getTime()) / 1000);
  const uptimeStr = uptime < 60 ? `${uptime}s` : `${Math.floor(uptime / 60)}m${uptime % 60}s`;

  console.log(
    `\n${c.bold}Team "${rt.name}"${c.reset}  supervisor PID ${rt.supervisorPid}  uptime ${uptimeStr}\n`,
  );

  console.log(
    `  ${'Personality'.padEnd(22)}${'Port'.padEnd(8)}${'Status'.padEnd(14)}${'PID'.padEnd(10)}Failures`,
  );
  console.log(`  ${'-'.repeat(60)}`);

  for (const m of rt.members) {
    const sc = statusColor(m.status);
    console.log(
      `  ${m.personality.padEnd(22)}${String(m.port).padEnd(8)}${sc}${m.status.padEnd(14)}${c.reset}${String(m.pid ?? '—').padEnd(10)}${m.failureCount}`,
    );
  }

  const { ethosDir } = await import('@ethosagent/config');
  const boardPath = join(ethosDir(), 'teams', effectiveName, 'board.db');
  if (existsSync(boardPath)) {
    try {
      const { KanbanStore, autonomyTier } = await import('@ethosagent/kanban-store');
      const manifest = parseTeamManifest(readFileSync(resolveManifestPath(effectiveName), 'utf-8'));
      const board = new KanbanStore(boardPath, { teamId: effectiveName });
      const stats = board.getMemberStats();
      board.close();
      if (stats.size > 0) {
        console.log(
          `  ${'Member'.padEnd(22)}${'Completed'.padEnd(12)}${'Failed'.padEnd(10)}${'Tier'}`,
        );
        console.log(`  ${'-'.repeat(52)}`);
        for (const [id, s] of stats) {
          const tier = autonomyTier(s, manifest.trust_policy);
          console.log(
            `  ${id.padEnd(22)}${String(s.ticketsCompleted).padEnd(12)}${String(s.ticketsFailed).padEnd(10)}${tier}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `  ${c.yellow}Warning: could not read board stats: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runTeamCreate(name: string | undefined, extraArgs: string[] = []): Promise<void> {
  const blank = extraArgs.includes('--blank') || extraArgs.includes('--non-interactive');

  if (blank) {
    await runTeamCreateBlank(name);
    return;
  }

  await runTeamCreateAiAssisted(name);
}

async function runTeamCreateBlank(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team create <name> --blank');
    process.exit(1);
  }

  const dir = teamsDir();
  const dest = join(dir, `${name}.yaml`);

  if (existsSync(dest)) {
    console.error(`Team "${name}" already exists at ${dest}`);
    process.exit(1);
  }

  try {
    const localSrc = readFileSync(resolvePath('./team.yaml'), 'utf-8');
    const localManifest = parseTeamManifest(localSrc);
    if (localManifest.name === name) {
      console.error(`Team "${name}" already exists (./team.yaml)`);
      process.exit(1);
    }
  } catch {
    /* no local team.yaml */
  }

  mkdirSync(dir, { recursive: true });

  const draft: TeamManifest = {
    name,
    description: `${name} team`,
    domain_capabilities: [],
    dispatch_mode: 'self-routing',
    members: [],
  };

  writeFileSync(dest, serializeTeamManifest(draft), 'utf-8');
  console.log(`\n${c.bold}Created team "${name}"${c.reset}  ${c.dim}${dest}${c.reset}`);
  console.log(`${c.dim}Add personalities:  ethos team ${name} add <personality>${c.reset}\n`);
}

async function runTeamCreateAiAssisted(name: string | undefined): Promise<void> {
  const { readConfig } = await import('@ethosagent/config');
  const { getStorage, getSecretsResolver } = await import('../wiring');
  const { runChat } = await import('./chat');
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');

  const config = await readConfig(getStorage(), await getSecretsResolver());
  if (!config) {
    console.error('Run `ethos setup` first.');
    process.exit(1);
  }

  const reg = await createPersonalityRegistry(getStorage());
  if (!reg.get('team-architect')) {
    console.error('team-architect personality not found. Is the framework installed correctly?');
    process.exit(1);
  }

  const overridden = { ...config, personality: 'team-architect' };

  const prompt = name
    ? `I want to create a new team called "${name}". Help me design it.`
    : undefined;

  console.log(`\n${c.bold}Team Architect${c.reset}`);
  console.log(
    `${c.dim}I'll help you design a team of specialist personalities. Let's start.${c.reset}\n`,
  );

  await runChat(overridden, {
    ...(prompt ? { singleQuery: prompt } : {}),
  });
}

// ---------------------------------------------------------------------------
// <name> add / remove
// ---------------------------------------------------------------------------

async function runTeamMemberAdd(teamName: string, personality: string | undefined): Promise<void> {
  if (!personality) {
    console.error(`Usage: ethos team ${teamName} add <personality>`);
    process.exit(1);
  }

  const manifestPath = resolveManifestPath(teamName);
  const manifest = parseTeamManifest(readFileSync(manifestPath, 'utf-8'));

  if (manifest.members.some((m) => m.personality === personality)) {
    console.log(`${c.dim}${personality} is already a member of team ${teamName}${c.reset}`);
    return;
  }

  // Look up personality capabilities to auto-populate domain_capabilities.
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { ethosDir } = await import('@ethosagent/config');
  const { getStorage } = await import('../wiring');
  const reg = await createPersonalityRegistry({
    storage: getStorage(),
    userPersonalitiesDir: ethosDir(),
  });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));
  const personalityConfig = reg.get(personality);
  if (!personalityConfig) {
    console.error(`Unknown personality: ${personality}`);
    console.error(`Run 'ethos personality list' to see available personalities.`);
    process.exit(1);
  }

  const personalityCapabilities = personalityConfig.capabilities ?? [];
  const updatedManifest: TeamManifest = {
    ...manifest,
    domain_capabilities: [
      ...new Set([...manifest.domain_capabilities, ...personalityCapabilities]),
    ],
    members: [...manifest.members, { personality, auto_restart: true }],
  };

  writeFileSync(manifestPath, serializeTeamManifest(updatedManifest), 'utf-8');
  console.log(`${c.green}✓${c.reset} Added ${c.bold}${personality}${c.reset} to team ${teamName}`);
  if (personalityCapabilities.length > 0) {
    console.log(`${c.dim}  capabilities: ${personalityCapabilities.join(', ')}${c.reset}`);
  }
}

async function runTeamMemberRemove(
  teamName: string,
  personality: string | undefined,
): Promise<void> {
  if (!personality) {
    console.error(`Usage: ethos team ${teamName} remove <personality>`);
    process.exit(1);
  }

  const manifestPath = resolveManifestPath(teamName);
  const manifest = parseTeamManifest(readFileSync(manifestPath, 'utf-8'));

  if (!manifest.members.some((m) => m.personality === personality)) {
    console.error(`${personality} is not a member of team ${teamName}`);
    process.exit(1);
  }

  const updatedManifest: TeamManifest = {
    ...manifest,
    members: manifest.members.filter((m) => m.personality !== personality),
  };

  writeFileSync(manifestPath, serializeTeamManifest(updatedManifest), 'utf-8');
  console.log(
    `${c.green}✓${c.reset} Removed ${c.bold}${personality}${c.reset} from team ${teamName}`,
  );
  if (updatedManifest.members.length === 0) {
    console.log(
      `${c.dim}  Team has no members — add one before starting: ethos team ${teamName} add <personality>${c.reset}`,
    );
  }
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

async function runTeamLogs(name: string | undefined, args: string[]): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team logs <name> [--member <personality>]');
    process.exit(1);
  }

  const rt = readRuntime(name);
  if (!rt) {
    console.error(
      `No log history found for team "${name}" — start it first with 'ethos team start ${name}'.`,
    );
    process.exit(1);
  }

  const memberArg = args.indexOf('--member');
  const memberFilter = memberArg >= 0 ? args[memberArg + 1] : undefined;

  const targets = memberFilter
    ? rt.members.filter((m) => m.personality === memberFilter)
    : rt.members;

  if (targets.length === 0) {
    console.error(
      memberFilter
        ? `No member with personality "${memberFilter}" in team "${name}".`
        : `No members found for team "${name}".`,
    );
    process.exit(1);
  }

  // Tail all target log files, prefixing each line with the personality name.
  // Uses `tail -F` which follows files across rotations.
  const { spawn: spawnTail } = await import('node:child_process');
  for (const m of targets) {
    const tail = spawnTail('tail', ['-F', m.logFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    const prefix = targets.length > 1 ? `${c.cyan}[${m.personality}]${c.reset} ` : '';
    tail.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line) process.stdout.write(`${prefix}${line}\n`);
      }
    });
  }

  // Keep alive until ctrl-c.
  await new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runTeamCommand(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case 'list':
    case '':
      await runTeamList(args);
      break;
    case 'create':
      await runTeamCreate(args[0], args.slice(1));
      break;
    case 'start':
      await runTeamStart(args[0]);
      break;
    case 'stop':
      await runTeamStop(args[0]);
      break;
    case 'destroy':
      await runTeamDestroy(args[0], args.slice(1));
      break;
    case 'status':
      await runTeamStatus(args[0], args);
      break;
    case 'logs':
      await runTeamLogs(args[0], args.slice(1));
      break;
    case 'retro':
      await runTeamRetro(args[0]);
      break;
    default: {
      // `ethos team <name> add|remove <personality>`
      const action = args[0] ?? '';
      if (action === 'add') {
        await runTeamMemberAdd(sub, args[1]);
      } else if (action === 'remove') {
        await runTeamMemberRemove(sub, args[1]);
      } else {
        console.log(
          'Usage: ethos team [list | create <name> | start <name> | stop <name> | destroy <name> [--yes] | status <name> | logs <name> | <name> add <personality> | <name> remove <personality>]',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// retro
// ---------------------------------------------------------------------------

async function runTeamRetro(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team retro <name>');
    process.exit(1);
  }

  const { ethosDir } = await import('@ethosagent/config');
  const { getStorage } = await import('../wiring');
  const storage = getStorage();
  const pmDir = join(ethosDir(), 'teams', name, 'memory', 'postmortems');
  const entries = await storage.listEntries(pmDir).catch(() => []);
  const files = entries.filter((e) => !e.isDir && e.name.endsWith('.md'));

  if (files.length === 0) {
    console.log(`\n${c.dim}No postmortems for team "${name}".${c.reset}\n`);
    return;
  }

  console.log(
    `\n${c.bold}Postmortems for team "${name}"${c.reset}  ${c.dim}(${files.length} entries)${c.reset}\n`,
  );

  const reasons: Map<string, number> = new Map();
  for (const f of files) {
    const content = await storage.read(join(pmDir, f.name));
    if (!content) continue;
    const reasonMatch = content.match(/\*\*Why it bounced:\*\*\s*(.+)/);
    if (reasonMatch) {
      const r = reasonMatch[1].trim();
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    const titleMatch = content.match(/^# (.+)/);
    const assigneeMatch = content.match(/\*\*Assignee:\*\*\s*(.+)/);
    const title = titleMatch ? titleMatch[1] : f.name;
    const assignee = assigneeMatch ? assigneeMatch[1].trim() : '?';
    console.log(`  ${c.cyan}${title}${c.reset}  ${c.dim}assignee: ${assignee}${c.reset}`);
  }

  const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`\n${c.bold}Top recurring reasons${c.reset}\n`);
    for (const [reason, count] of sorted.slice(0, 3)) {
      console.log(`  ${c.yellow}${count}x${c.reset}  ${reason}`);
    }
  }
  console.log();
}

export function buildSupervisorLaunchArgs(
  entryPoint: string,
  teamName: string,
  manifestPath: string,
): string[] {
  const needsTsxLoader = entryPoint.endsWith('.ts') || entryPoint.endsWith('.tsx');
  return needsTsxLoader
    ? ['--import', 'tsx', entryPoint, '_supervisor', teamName, manifestPath]
    : [entryPoint, '_supervisor', teamName, manifestPath];
}
