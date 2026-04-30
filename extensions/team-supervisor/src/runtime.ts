import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type MemberStatus = 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

export interface MemberRuntime {
  personality: string;
  port: number;
  pid: number | null;
  status: MemberStatus;
  failureCount: number;
  logFile: string;
}

export interface TeamRuntime {
  name: string;
  manifestPath: string;
  supervisorPid: number;
  startedAt: string;
  members: MemberRuntime[];
}

export function teamsDir(): string {
  return join(homedir(), '.ethos', 'teams');
}

export function runtimePath(name: string): string {
  return join(teamsDir(), `${name}.runtime.json`);
}

export function pidFilePath(name: string): string {
  return join(teamsDir(), `${name}.pid`);
}

export function teamLogDir(name: string): string {
  return join(homedir(), '.ethos', 'logs', 'team', name);
}

export function writeRuntime(state: TeamRuntime): void {
  const path = runtimePath(state.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function readRuntime(name: string): TeamRuntime | null {
  try {
    const src = readFileSync(runtimePath(name), 'utf-8');
    return JSON.parse(src) as TeamRuntime;
  } catch {
    return null;
  }
}

export function removeRuntime(name: string): void {
  try {
    const { unlinkSync } = require('node:fs');
    unlinkSync(runtimePath(name));
  } catch {
    /* ignore */
  }
}
