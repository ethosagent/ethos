import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { MemberRuntime } from '@ethosagent/team-supervisor';
import {
  parseTeamManifest,
  readRuntime,
  teamsDir,
  validateForStart,
} from '@ethosagent/team-supervisor';
import type { TeamManifest } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';

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

async function runTeamList(): Promise<void> {
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
    console.log(`${c.dim}No teams found. Create one at ~/.ethos/teams/<name>.yaml${c.reset}`);
    return;
  }

  console.log(`\n${c.bold}Teams:${c.reset}\n`);
  for (const file of files) {
    const teamName = basename(file, '.yaml');
    const rt = readRuntime(teamName);
    const liveMembers = rt?.members.filter((m) => m.status !== 'stopped' && m.status !== 'failed');
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

  console.log(
    `\n${c.bold}Starting team "${manifest.name}"${c.reset} (${manifest.members.length} members)`,
  );

  // Spawn the supervisor as a detached background process.
  const child = spawn(
    process.argv[0] ?? 'node',
    [process.argv[1] ?? '', '_supervisor', name, manifestPath],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
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
  if (!rt) {
    console.error(`Team "${name}" does not appear to be running (no runtime file).`);
    process.exit(1);
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

async function runTeamStatus(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team status <name>');
    process.exit(1);
  }

  const rt = readRuntime(name);
  if (!rt) {
    console.log(`Team "${name}": ${c.dim}stopped${c.reset} (no runtime file)`);
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
  console.log();
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runTeamCreate(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos team create <name>');
    process.exit(1);
  }

  const dir = teamsDir();
  const dest = join(dir, `${name}.yaml`);

  if (existsSync(dest)) {
    console.error(`Team "${name}" already exists at ${dest}`);
    process.exit(1);
  }

  // Check local ./team.yaml doesn't already match this name
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
  const { ethosDir } = await import('../config');
  const reg = await createPersonalityRegistry({ userPersonalitiesDir: ethosDir() });
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
      await runTeamList();
      break;
    case 'create':
      await runTeamCreate(args[0]);
      break;
    case 'start':
      await runTeamStart(args[0]);
      break;
    case 'stop':
      await runTeamStop(args[0]);
      break;
    case 'status':
      await runTeamStatus(args[0]);
      break;
    case 'logs':
      await runTeamLogs(args[0], args.slice(1));
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
          'Usage: ethos team [list | create <name> | start <name> | stop <name> | status <name> | logs <name> | <name> add <personality> | <name> remove <personality>]',
        );
      }
    }
  }
}
