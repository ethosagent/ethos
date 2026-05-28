// CC-3: Single supervisor per team — PID file flock + liveness check.
//
// `ethos team start <name>` MUST refuse cleanly if another supervisor already
// owns the team. Tested by calling acquirePidFile twice for the same path:
// first call succeeds; second call sees EEXIST + a live PID and throws.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquirePidFile } from '../../pid';

let workDir;
beforeEach(() => {
  workDir = join(tmpdir(), `ethos-pid-cc3-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});
describe('CC-3: PID file single-supervisor guarantee', () => {
  it('first acquirePidFile succeeds and creates the file', () => {
    const pidPath = join(workDir, 'test.pid');
    const release = acquirePidFile(pidPath);
    const { readFileSync, existsSync } = require('node:fs');
    expect(existsSync(pidPath)).toBe(true);
    expect(Number(readFileSync(pidPath, 'utf-8').trim())).toBe(process.pid);
    release();
    expect(existsSync(pidPath)).toBe(false);
  });
  it('second acquirePidFile for same path throws "already running" when PID is alive', () => {
    const pidPath = join(workDir, 'test.pid');
    const release = acquirePidFile(pidPath);
    // Second call must throw because the current process (the "first supervisor")
    // is alive.
    expect(() => acquirePidFile(pidPath)).toThrow(/already running/i);
    release();
  });
  it('release removes the PID file', () => {
    const pidPath = join(workDir, 'test.pid');
    const release = acquirePidFile(pidPath);
    release();
    const { existsSync } = require('node:fs');
    expect(existsSync(pidPath)).toBe(false);
  });
  it('acquirePidFile recovers a stale PID file from a crashed previous run', () => {
    const pidPath = join(workDir, 'stale.pid');
    // Write a PID that is guaranteed not to exist (PID 0 is the kernel, never
    // a user process; kill(0, 0) would target the process group, so use 1
    // instead — or a large number unlikely to be a real process).
    // Actually the cleanest approach: write a PID that surely doesn't exist.
    // On Linux/macOS, PIDs > 4_194_304 are invalid; Node's max is system-
    // dependent but 9_999_999 is safe to assume stale.
    const stalePid = 9_999_999;
    writeFileSync(pidPath, String(stalePid));
    // Should NOT throw — it detects the stale PID and retakes the lock.
    let release;
    expect(() => {
      release = acquirePidFile(pidPath);
    }).not.toThrow();
    const { readFileSync } = require('node:fs');
    expect(Number(readFileSync(pidPath, 'utf-8').trim())).toBe(process.pid);
    release?.();
  });
  it('two concurrent acquirePidFile calls for the same path: exactly one succeeds', () => {
    const pidPath = join(workDir, 'race.pid');
    let successCount = 0;
    let errorCount = 0;
    let releaser;
    for (let i = 0; i < 2; i++) {
      try {
        const rel = acquirePidFile(pidPath);
        successCount++;
        releaser = rel;
      } catch {
        errorCount++;
      }
    }
    expect(successCount).toBe(1);
    expect(errorCount).toBe(1);
    releaser?.();
  });
});
