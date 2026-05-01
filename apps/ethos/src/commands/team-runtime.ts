import type { TeamRuntime } from '@ethosagent/team-supervisor';

export type RuntimeHealth = 'missing' | 'running' | 'stale';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runtimeHealth(runtime: TeamRuntime | null): RuntimeHealth {
  if (!runtime) return 'missing';
  return isPidAlive(runtime.supervisorPid) ? 'running' : 'stale';
}
