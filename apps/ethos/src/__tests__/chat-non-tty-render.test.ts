// Non-TTY render gate — `ethos chat | tee log` gets static feed lines only.
// Before the gate, runTurn drew the thinking spinner and the C1 live tool
// block unconditionally, so erase/redraw cursor escapes (`\r\x1b[2K`,
// `\x1b[1A\x1b[2K`) streamed into pipes for the whole turn. With
// `!process.stdout.isTTY` the REPL never draws the live block and never
// (re)starts the thinking spinner (`repaintTickAction` in lib/tool-spinner.ts
// carries the tick-level gate; the initial draw and the tool_end restart are
// gated inline in chat.ts runTurn).
//
// Driven as a REAL process, same harness as chat-piped-exit.test.ts: HOME and
// ETHOS_STATE_DIR point into a fresh temp dir, and the dead `baseUrl` keeps
// the turn off the network (the provider error still exercises the whole
// spinner/live-block lifecycle: turn start, error event, finally).

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
  const dir = await mkdtemp(join(tmpdir(), 'ethos-chat-nontty-'));
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

describe('ethos chat non-TTY render', () => {
  it('a full turn emits no cursor-movement escapes into the pipe', async () => {
    const { code, stdout } = await chatWithStdin('hi\n');
    // Erase-line and cursor-up are the in-place repaint machinery; neither
    // belongs in a pipe. (SGR color codes are a separate concern.)
    expect(stdout).not.toContain('\x1b[2K');
    expect(stdout).not.toContain('\x1b[1A');
    // The spinner's carriage-return overwrite frame never appears either.
    expect(stdout).not.toContain('\r\x1b');
    // The thinking spinner line itself is never drawn on a pipe.
    expect(stdout).not.toContain('thinking');
    expect(code).toBe(0);
  }, 120_000);
});
