import type { SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import type { TeamRuntimeConfig } from '@ethosagent/config';
import { type TeamRuntime, teamsDir } from '@ethosagent/team-supervisor';
import { buildSupervisorLaunchArgs } from './team';

/**
 * Minimal bot-binding shape needed by the supervisor lifecycle helpers.
 * Intentionally kept narrow so this module does not import @ethosagent/gateway
 * (daemon-free doctrine: only commands/gateway.ts may import that package).
 */
export interface BotBindingEntry {
  binding: { type: 'personality' | 'team'; name: string };
}

export interface ChildProcessLike {
  pid?: number;
  unref(): void;
}

export interface SupervisorLifecycleDeps {
  readRuntime: (name: string) => TeamRuntime | null;
  isPidAlive: (pid: number) => boolean;
  removeRuntime: (name: string) => void;
  spawn: (exe: string, args: string[], opts: SpawnOptions) => ChildProcessLike;
  /** Milliseconds to wait after spawning before re-reading the runtime file. Default 500. */
  waitMs?: number;
}

export interface EnsureResult {
  status: 'already-running' | 'spawned';
  pid?: number;
}

/**
 * Ensure the team supervisor for `teamName` is running.
 *
 * - Already running → no-op, returns `{ status: 'already-running' }`.
 * - Stale runtime (PID gone) → removes stale file, then spawns.
 * - Missing runtime → spawns.
 *
 * The supervisor is launched detached+unref'd, identical to `ethos team start`.
 */
export async function ensureSupervisorRunning(
  teamName: string,
  entryPoint: string,
  deps: SupervisorLifecycleDeps,
): Promise<EnsureResult> {
  const runtime = deps.readRuntime(teamName);
  if (runtime && deps.isPidAlive(runtime.supervisorPid)) {
    return { status: 'already-running', pid: runtime.supervisorPid };
  }
  if (runtime) {
    // Stale — PID is dead; clean up before respawning.
    deps.removeRuntime(teamName);
  }

  const manifestPath = teamManifestPath(teamName);
  const args = buildSupervisorLaunchArgs(entryPoint, teamName, manifestPath);
  const child = deps.spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const waitMs = deps.waitMs ?? 500;
  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  // Verify the supervisor wrote its runtime file and the PID is alive.
  // If not, we still return 'spawned' but with pid: undefined so callers
  // can surface a warning rather than silently accepting a broken state.
  const postSpawnRuntime = deps.readRuntime(teamName);
  const confirmedPid =
    postSpawnRuntime && deps.isPidAlive(postSpawnRuntime.supervisorPid)
      ? postSpawnRuntime.supervisorPid
      : undefined;

  return { status: 'spawned', pid: confirmedPid };
}

export interface StopDeps {
  readRuntime: (name: string) => TeamRuntime | null;
  isPidAlive: (pid: number) => boolean;
  kill: (pid: number, signal: string) => void;
}

/** Combined deps for gateway-level helpers that both spawn and stop. */
export type TeamSupervisorDeps = SupervisorLifecycleDeps & StopDeps;

/**
 * Send SIGTERM to the supervisor for `teamName` if it is currently running.
 * Used by the gateway shutdown handler when `team.<name>.autoStop: true`.
 */
export function stopSupervisor(teamName: string, deps: StopDeps): void {
  const runtime = deps.readRuntime(teamName);
  if (!runtime) return;
  if (!deps.isPidAlive(runtime.supervisorPid)) return;
  deps.kill(runtime.supervisorPid, 'SIGTERM');
}

/**
 * For each unique team name in `bots`, ensure the team supervisor is running.
 * Personality-bound bots are skipped.
 * Returns a map of team name → result for gateway logging.
 */
export async function ensureTeamSupervisors(
  bots: BotBindingEntry[],
  entryPoint: string,
  deps: TeamSupervisorDeps,
): Promise<Map<string, EnsureResult>> {
  const results = new Map<string, EnsureResult>();
  const seen = new Set<string>();
  for (const bot of bots) {
    if (bot.binding.type !== 'team') continue;
    const teamName = bot.binding.name;
    if (seen.has(teamName)) continue;
    seen.add(teamName);
    const result = await ensureSupervisorRunning(teamName, entryPoint, deps);
    results.set(teamName, result);
  }
  return results;
}

/**
 * Stop supervisors for team-bound bots whose team config has `autoStop: true`.
 * Only sends SIGTERM if the supervisor is currently alive.
 */
export function stopTeamSupervisors(
  bots: BotBindingEntry[],
  teamsCfg: Record<string, TeamRuntimeConfig>,
  deps: TeamSupervisorDeps,
): void {
  const seen = new Set<string>();
  for (const bot of bots) {
    if (bot.binding.type !== 'team') continue;
    const teamName = bot.binding.name;
    if (seen.has(teamName)) continue;
    seen.add(teamName);
    if (teamsCfg[teamName]?.autoStop) {
      stopSupervisor(teamName, deps);
    }
  }
}

function teamManifestPath(teamName: string): string {
  return join(teamsDir(), `${teamName}.yaml`);
}
