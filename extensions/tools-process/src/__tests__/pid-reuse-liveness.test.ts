// V2-SEC-5 — liveness was `kill(pid, 0)` alone, so an entry whose pid was
// reused after a restart stayed `running` for good: reconcile and list never
// orphaned it, process_wait polled to its deadline, process_watch never saw
// the exit, and the ghost held one of the personality's PROCESS_CAP slots.
// One predicate now decides (`isEntryAlive`, ../registry.ts): the pid is alive
// AND still wears the recorded identity (verify2-sec/pid.mts).

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessTools } from '../index';
import { listProcesses, reconcileRegistry } from '../operations';
import { loadRegistry, type ProcessEntry, saveRegistry } from '../registry';

let dataDir: string;
const dummies: ChildProcess[] = [];

/** A live process that is NOT the one the entry recorded: the reused pid. */
function reusedPid(): number {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  dummies.push(child);
  if (child.pid === undefined) throw new Error('spawn failed');
  return child.pid;
}

function ghost(id: string, pid: number, startedBy = 'tester'): ProcessEntry {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    pid,
    command: 'sleep 999',
    cwd: dataDir,
    status: 'running',
    startedAt: now,
    lastTouchedAt: now,
    started_by: startedBy,
    pidStartToken: 'recorded-for-a-different-process',
  };
}

function ctx() {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: dataDir,
    personalityId: 'tester',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function tool(name: string): Tool {
  const t = createProcessTools(dataDir).find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
}

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-pid-reuse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  for (const d of dummies.splice(0)) d.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'a reused pid is not the tracked process (V2-SEC-5)',
  () => {
    it('reconcileRegistry and process_list report it orphan', async () => {
      saveRegistry(dataDir, { stale: ghost('stale', reusedPid()) });
      await reconcileRegistry(dataDir);
      expect(loadRegistry(dataDir).stale?.status).toBe('orphan');

      saveRegistry(dataDir, { stale2: ghost('stale2', reusedPid()) });
      const items = await listProcesses(dataDir);
      expect(items.map((i) => [i.id, i.status])).toEqual([['stale2', 'orphan']]);
    });

    it('process_wait returns exited instead of polling to its deadline', async () => {
      saveRegistry(dataDir, { stale: ghost('stale', reusedPid()) });
      const started = Date.now();
      const result = await tool('process_wait').execute({ id: 'stale', timeout_s: 5 }, ctx());
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.ok && JSON.parse(result.value).exited).toBe(true);
      expect(loadRegistry(dataDir).stale?.status).toBe('orphan');
    });

    it('process_watch sees the exit', async () => {
      saveRegistry(dataDir, { stale: ghost('stale', reusedPid()) });
      const started = Date.now();
      const result = await tool('process_watch').execute(
        { id: 'stale', patterns: ['never'], timeout_s: 5 },
        ctx(),
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.ok && JSON.parse(result.value).process_exited).toBe(true);
    });

    it('ghosts do not hold the PROCESS_CAP slots', async () => {
      const reg: Record<string, ProcessEntry> = {};
      for (let i = 0; i < 8; i++) reg[`g${i}`] = ghost(`g${i}`, reusedPid());
      saveRegistry(dataDir, reg);
      const result = await tool('process_start').execute({ command: 'sleep 0.1' }, ctx());
      expect(result.ok).toBe(true);
    });
  },
);
