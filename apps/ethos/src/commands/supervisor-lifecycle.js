import { join } from 'node:path';
import { teamsDir } from '@ethosagent/team-supervisor';
import { buildSupervisorLaunchArgs } from './team';
/**
 * Ensure the team supervisor for `teamName` is running.
 *
 * - Already running → no-op, returns `{ status: 'already-running' }`.
 * - Stale runtime (PID gone) → removes stale file, then spawns.
 * - Missing runtime → spawns.
 *
 * The supervisor is launched detached+unref'd, identical to `ethos team start`.
 */
export async function ensureSupervisorRunning(teamName, entryPoint, deps) {
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
    await new Promise((resolve) => setTimeout(resolve, waitMs));
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
/**
 * Send SIGTERM to the supervisor for `teamName` if it is currently running.
 * Used by the gateway shutdown handler when `team.<name>.autoStop: true`.
 */
export function stopSupervisor(teamName, deps) {
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
export async function ensureTeamSupervisors(bots, entryPoint, deps) {
  const results = new Map();
  const seen = new Set();
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
export function stopTeamSupervisors(bots, teamsCfg, deps) {
  const seen = new Set();
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
function teamManifestPath(teamName) {
  return join(teamsDir(), `${teamName}.yaml`);
}
