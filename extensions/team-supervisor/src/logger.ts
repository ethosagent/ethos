import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SupervisorEventKind =
  | 'spawn'
  | 'exit'
  | 'restart'
  | 'give_up'
  | 'probe_fail'
  | 'probe_ok'
  | 'degraded'
  | 'dispatch_error';

export interface SupervisorLogEntry {
  ts: string;
  team: string;
  personality: string;
  event: SupervisorEventKind;
  data?: Record<string, unknown>;
}

export function supervisorLogPath(): string {
  return join(homedir(), '.ethos', 'logs', 'mesh-supervisor.log');
}

/** Append a structured event line to `~/.ethos/logs/mesh-supervisor.log`. */
export function logSupervisorEvent(entry: SupervisorLogEntry): void {
  const path = supervisorLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify({ ...entry, ts: entry.ts || new Date().toISOString() })}\n`;
  // O_APPEND guarantees atomic single-write position on POSIX — safe from concurrent supervisors.
  appendFileSync(path, line);
}
