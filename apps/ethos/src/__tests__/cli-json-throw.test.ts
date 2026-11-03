// A command that THROWS under --json still owes stdout one `{ok:false,error:{code,message}}`
// doc: the top-level catch in apps/ethos/src/index.ts writes it after the stderr rendering.
// Driven as a REAL process like chat-piped-exit.test.ts, because index.ts dispatches at module
// top level. A `memory: vector` config makes openFileMemory throw NOT_CONFIGURED.

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

async function run(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ethos-json-throw-'));
  dirs.push(dir);
  const state = join(dir, 'state');
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, 'config.yaml'),
    'schemaVersion: 1\nprovider: anthropic\napiKey: sk-ant-test-000\nmodel: test\nmemory: vector\n',
  );
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: join(dir, 'home'), ETHOS_STATE_DIR: state, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

describe('top-level catch under --json', () => {
  it('a throwing command prints one error doc on stdout and still renders stderr', async () => {
    const r = await run(['memory', 'restore', 'x', '--json']);
    expect(r.code).toBe(1);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe('NOT_CONFIGURED');
    expect(typeof doc.error.message).toBe('string');
    expect(r.stderr).toContain('NOT_CONFIGURED');
  }, 60_000);

  it('without --json stdout stays empty', async () => {
    const r = await run(['memory', 'restore', 'x']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
  }, 60_000);
});
