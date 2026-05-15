import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_MAX_BYTES, rotateLogIfNeeded, spawnDetached } from '../spawn';

let dataDir: string;
const spawnedPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  while (spawnedPids.length > 0) {
    const pid = spawnedPids.pop();
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('spawnDetached', () => {
  it('returns a pid and the process is alive', async () => {
    const result = spawnDetached('p1', 'sleep 30', dataDir, undefined, dataDir);
    spawnedPids.push(result.pid);
    expect(result.pid).toBeGreaterThan(0);
    expect(isAlive(result.pid)).toBe(true);
  });

  it('creates and writes the log files', async () => {
    const result = spawnDetached('p2', 'echo hello-stdout', dataDir, undefined, dataDir);
    spawnedPids.push(result.pid);
    await waitFor(
      () =>
        existsSync(result.stdoutLog) &&
        readFileSync(result.stdoutLog, 'utf8').includes('hello-stdout'),
    );
    expect(existsSync(result.stderrLog)).toBe(true);
  });

  it('detached child outlives the process that spawned it', async () => {
    // Spawn a short-lived node "parent" that itself spawns a detached `sleep`
    // via spawnDetached, writes the grandchild pid to a file, then exits.
    // The detached grandchild must still be alive after that parent is gone.
    const pidFile = join(dataDir, 'grandchild-pid.txt');
    const spawnModule = join(__dirname, '..', 'spawn.ts');
    const tsxBin = require.resolve('tsx/cli');
    const parentScript = join(dataDir, 'parent.ts');
    writeFileSync(
      parentScript,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { spawnDetached } from ${JSON.stringify(spawnModule)};`,
        `const r = spawnDetached('gc', 'sleep 10', ${JSON.stringify(dataDir)}, undefined, ${JSON.stringify(dataDir)});`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(r.pid), 'utf8');`,
      ].join('\n'),
      'utf8',
    );
    // Run the parent to completion — execFileSync returns only after it exits.
    // Cap the wait so a stuck subprocess fails this test fast instead of
    // wedging the whole vitest run.
    execFileSync(process.execPath, [tsxBin, parentScript], { timeout: 30_000 });
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    spawnedPids.push(grandchildPid);
    // Parent process has fully exited; grandchild must still be alive.
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isAlive(grandchildPid)).toBe(true);
  });

  it('detached child is in its own process group (survives parent group signals)', async () => {
    const result = spawnDetached('p4', 'sleep 10', dataDir, undefined, dataDir);
    spawnedPids.push(result.pid);
    // detached:true puts the child in a new process group whose pgid === child pid.
    const pgid = Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(result.pid)])
        .toString()
        .trim(),
    );
    expect(pgid).toBe(result.pid);
  });
});

describe('rotateLogIfNeeded', () => {
  it('does nothing when the file is under the size threshold', () => {
    const dir = join(dataDir, 'processes', 'r1');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'stdout.log');
    writeFileSync(log, 'small', 'utf8');
    rotateLogIfNeeded(log);
    expect(existsSync(`${log}.1`)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('small');
  });

  it('rotates when the file exceeds the size threshold', () => {
    const dir = join(dataDir, 'processes', 'r2');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'stdout.log');
    writeFileSync(log, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');
    rotateLogIfNeeded(log);
    // current log is renamed to .1, a fresh empty log takes its place
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(existsSync(log)).toBe(true);
    expect(statSync(log).size).toBe(0);
    expect(statSync(`${log}.1`).size).toBe(LOG_MAX_BYTES + 1);
  });

  it('shifts generations and keeps at most 5, dropping the oldest', () => {
    const dir = join(dataDir, 'processes', 'r3');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'stdout.log');
    // rotate 7 times; only .1..*.5 should survive plus the live log
    for (let i = 1; i <= 7; i++) {
      writeFileSync(log, `gen${i}-${'x'.repeat(LOG_MAX_BYTES + 1)}`, 'utf8');
      rotateLogIfNeeded(log);
    }
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(existsSync(`${log}.5`)).toBe(true);
    expect(existsSync(`${log}.6`)).toBe(false);
    // newest rotated generation (.1) holds the most recent pre-rotation content (gen7)
    expect(readFileSync(`${log}.1`, 'utf8')).toContain('gen7');
    // oldest surviving (.5) holds gen3 — gen1 and gen2 were dropped
    expect(readFileSync(`${log}.5`, 'utf8')).toContain('gen3');
  });

  it('tolerates concurrent rotation of the same oversized log without throwing', () => {
    const dir = join(dataDir, 'processes', 'r4');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'stdout.log');
    writeFileSync(log, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');
    // Two observers race through statSync -> renameSync. Neither should throw
    // ENOENT; the loser's rename is a no-op.
    expect(() => {
      rotateLogIfNeeded(log);
      rotateLogIfNeeded(log);
    }).not.toThrow();
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(statSync(log).size).toBe(0);
  });

  it('rotates a fresh-spawn log when it is already oversized', async () => {
    const dir = join(dataDir, 'processes', 'p5');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'stdout.log');
    writeFileSync(log, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');
    // spawnDetached should rotate the oversized log before re-opening it for append
    const result = spawnDetached('p5', 'echo after-rotate', dataDir, undefined, dataDir);
    spawnedPids.push(result.pid);
    expect(existsSync(`${log}.1`)).toBe(true);
    await waitFor(() => readFileSync(log, 'utf8').includes('after-rotate'));
    // fresh log should not contain the pre-rotation filler
    expect(readFileSync(log, 'utf8')).not.toContain('xxxxxxxxxx');
  });
});
