import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamManifest } from '@ethosagent/types';
import { acquirePidFile } from './pid';
import { allocatePorts } from './ports';
import type { MemberRuntime, MemberStatus } from './runtime';
import { pidFilePath, teamLogDir, writeRuntime } from './runtime';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const MAX_FAILURES_PER_MINUTE = 5;
const FAILURE_WINDOW_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;

interface MemberState extends MemberRuntime {
  child: ChildProcess | null;
  /** Unix timestamps (ms) of recent crash events, for rate-limiting restarts. */
  recentFailures: number[];
}

/**
 * Run the team supervisor for `manifest`. Blocks until the team is stopped
 * (SIGTERM / SIGINT). Designed to be called from an isolated child process
 * launched by `ethos team start`.
 */
export async function runSupervisor(manifest: TeamManifest, manifestPath: string): Promise<void> {
  const name = manifest.name;
  const pidPath = pidFilePath(name);

  // CC-3: acquire exclusive PID file before doing anything else.
  const releasePid = acquirePidFile(pidPath);

  const logDir = teamLogDir(name);
  mkdirSync(logDir, { recursive: true });

  // CC-2: allocate ports upfront.
  const allocations = await allocatePorts(manifest.members);

  // Build per-member state.
  const memberMap = new Map<string, MemberState>();
  for (const { personality, port } of allocations) {
    const logFile = join(logDir, `${personality}.log`);
    memberMap.set(personality, {
      personality,
      port,
      pid: null,
      status: 'starting' as MemberStatus,
      failureCount: 0,
      logFile,
      child: null,
      recentFailures: [],
    });
  }

  const startedAt = new Date().toISOString();
  let shuttingDown = false;

  function persist(): void {
    writeRuntime({
      name,
      manifestPath,
      supervisorPid: process.pid,
      startedAt,
      members: [...memberMap.values()].map(({ child: _child, recentFailures: _rf, ...m }) => m),
    });
  }

  persist();

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[team-supervisor] Stopping team "${name}"…`);

    // Send SIGTERM to all live children.
    for (const m of memberMap.values()) {
      if (m.child && m.pid) {
        try {
          process.kill(m.pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }

    // Wait for grace period, then SIGKILL stragglers.
    await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));

    for (const m of memberMap.values()) {
      if (m.child && m.pid) {
        try {
          process.kill(m.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      m.status = 'stopped';
      m.pid = null;
    }

    persist();
    releasePid();
    process.exit(0);
  }

  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  function spawnMember(personality: string): void {
    const m = memberMap.get(personality);
    const member = manifest.members.find((mm) => mm.personality === personality);
    if (!m || !member || shuttingDown) return;

    const logStream = createWriteStream(m.logFile, { flags: 'a' });

    const child = spawn(
      process.argv[0] ?? 'node',
      [process.argv[1] ?? '', 'serve', '--port', String(m.port), '--personality', personality],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
    );

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    m.child = child;
    m.pid = child.pid ?? null;
    m.status = 'running';
    persist();

    console.log(`[team-supervisor] Spawned ${personality} on port ${m.port} (PID ${m.pid ?? '?'})`);

    child.on('exit', (code, signal) => {
      if (shuttingDown) return;

      logStream.end();
      m.child = null;
      m.pid = null;

      const autoRestart = member.auto_restart ?? false;
      if (!autoRestart) {
        m.status = 'failed';
        console.error(
          `[team-supervisor] ${personality} exited (code=${code}, signal=${signal}); auto_restart disabled`,
        );
        persist();
        return;
      }

      // Rate-limit: prune failures outside the window, then add this one.
      const now = Date.now();
      m.recentFailures = m.recentFailures.filter((t) => now - t < FAILURE_WINDOW_MS);
      m.recentFailures.push(now);
      m.failureCount++;

      if (m.recentFailures.length >= MAX_FAILURES_PER_MINUTE) {
        m.status = 'failed';
        console.error(
          `[team-supervisor] ${personality}: giving up — ${MAX_FAILURES_PER_MINUTE} failures in ${FAILURE_WINDOW_MS / 1000}s`,
        );
        persist();
        return;
      }

      const backoff = Math.min(
        BACKOFF_BASE_MS * 2 ** (m.recentFailures.length - 1),
        BACKOFF_CAP_MS,
      );
      m.status = 'restarting';
      persist();
      console.log(`[team-supervisor] ${personality}: restarting in ${backoff}ms`);

      setTimeout(() => {
        if (!shuttingDown) spawnMember(personality);
      }, backoff);
    });
  }

  // Spawn all members at startup.
  for (const personality of memberMap.keys()) {
    spawnMember(personality);
  }

  // Block indefinitely — signals drive shutdown.
  await new Promise<never>(() => {});
}
