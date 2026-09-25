// `sessions.ts` installs a SIGTERM/SIGINT listener at import. Any listener
// switches off Node's default "terminate on signal", so a cleanup-only listener
// made the first SIGTERM to `ethos gateway start` a no-op whenever it landed
// before the command registered its own shutdown handler (the process kept
// running until a second signal). What is under test is whether a real process
// ends, which only a real child can show — so these spawn one.
//
// Child-process precedent: apps/ethos/src/__tests__/approval-shutdown-exit-order.test.ts
// (and its note on why `node --import tsx`, not the `tsx` bin).

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SESSIONS = join(REPO_ROOT, 'extensions', 'tools-browser', 'src', 'sessions');

/** Far above a healthy exit (cleanup of one fake session), far below the 5s
 *  `SIGNAL_CLEANUP_BOUND_MS` a hung cleanup would wait. */
const EXIT_WITHIN_MS = 4_000;

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

async function runChild(dir: string, body: string): Promise<Outcome> {
  const scriptPath = join(dir, 'child.ts');
  await writeFile(
    scriptPath,
    `import { makeMapKey, sessions } from ${JSON.stringify(SESSIONS)};
void makeMapKey; void sessions;
${body}
process.stdout.write('READY\\n');
// Keep the child alive until the signal lands.
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const readyBy = Date.now() + 15_000;
  while (!stdout.includes('READY')) {
    if (Date.now() > readyBy) {
      child.kill('SIGKILL');
      throw new Error(`child never became ready\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    exited,
    new Promise<'alive'>((resolve) => {
      timer = setTimeout(() => resolve('alive'), EXIT_WITHIN_MS);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === 'alive') {
    child.kill('SIGKILL');
    throw new Error(`SIGTERM was swallowed: child still running after ${EXIT_WITHIN_MS}ms`);
  }
  return { ...outcome, stdout };
}

describe('tools-browser signal listener', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-browser-signal-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a SIGTERM nothing else handles still ends the process', async () => {
    const { code, signal } = await runChild(dir, '');
    expect(signal).toBe('SIGTERM');
    expect(code).toBeNull();
  }, 30_000);

  it('closes open browser sessions before the signal ends the process', async () => {
    const { signal, stdout } = await runChild(
      dir,
      `sessions.set(makeMapKey('sig', {}), {
  close: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stdout.write('CLOSED\\n');
  },
} as never);`,
    );
    expect(stdout).toContain('CLOSED');
    expect(signal).toBe('SIGTERM');
  }, 30_000);

  it("leaves the exit to the host's own handler when there is one", async () => {
    const { code, signal, stdout } = await runChild(
      dir,
      `process.on('SIGTERM', () => {
  process.stdout.write('HOST\\n');
  setTimeout(() => process.exit(0), 300);
});`,
    );
    expect(signal).toBeNull();
    expect(code).toBe(0);
    // Exactly once: the browser listener must not re-raise into the host.
    expect(stdout.match(/HOST/g)).toHaveLength(1);
  }, 30_000);
});
