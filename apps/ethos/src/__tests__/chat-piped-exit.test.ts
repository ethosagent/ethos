// `ethos chat` with piped stdin: `/exit` and EOF end the REPL with code 0 and
// no "readline was closed". `/exit` closes the interface from inside the slash
// handler, whose `.then` then re-prompted a closed `rl` (ERR_USE_AFTER_CLOSE)
// while the `close` handler was still releasing the runtime; EOF closes it the
// same way under an in-flight continuation. Every prompt now goes through
// `reprompt` in apps/ethos/src/commands/chat.ts.
//
// Driven as a REAL process, the way `personality-show-mcp-export.test.ts`
// does: `apps/ethos/src/index.ts` dispatches at module top level. HOME and
// ETHOS_STATE_DIR point into a fresh temp dir so the real `~/.ethos` is never
// touched, and the dead `baseUrl` keeps the run off the network.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CLI = join(ROOT, 'apps', 'ethos', 'src', 'index.ts');

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function chatWithStdin(
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ethos-chat-piped-'));
  dirs.push(dir);
  const state = join(dir, 'state');
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, 'config.yaml'),
    [
      'schemaVersion: 1',
      'provider: anthropic',
      'apiKey: sk-ant-test-000',
      'baseUrl: http://127.0.0.1:1',
      'model: test',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'chat'], {
    cwd: ROOT,
    env: { ...process.env, HOME: join(dir, 'home'), ETHOS_STATE_DIR: state, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ethos chat did not exit:\n${stdout}\n${stderr}`));
    }, 90_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  child.stdin.end(input);
  const code = await exited;
  return { code, stdout, stderr };
}

describe('ethos chat with piped stdin', () => {
  it('/exit exits 0 without "readline was closed"', async () => {
    const { code, stdout, stderr } = await chatWithStdin('/exit\n');
    expect(stdout).toContain('/exit');
    expect(`${stdout}${stderr}`).not.toContain('readline was closed');
    expect(code).toBe(0);
  }, 120_000);

  it('EOF after a slash command exits 0 without "readline was closed"', async () => {
    const { code, stdout, stderr } = await chatWithStdin('/help\n');
    expect(stdout).toContain('/exit');
    expect(`${stdout}${stderr}`).not.toContain('readline was closed');
    expect(code).toBe(0);
  }, 120_000);

  it('EOF after a message exits 0 without "readline was closed"', async () => {
    const { code, stdout, stderr } = await chatWithStdin('hi\n');
    expect(`${stdout}${stderr}`).not.toContain('readline was closed');
    expect(code).toBe(0);
  }, 120_000);

  it('EOF with nothing typed (Ctrl-D at an empty prompt) exits 0', async () => {
    const { code, stdout, stderr } = await chatWithStdin('');
    expect(`${stdout}${stderr}`).not.toContain('readline was closed');
    expect(code).toBe(0);
  }, 120_000);
});
