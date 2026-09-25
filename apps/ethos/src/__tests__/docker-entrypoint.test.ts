// docker/docker-entrypoint.sh refuses a state dir the runtime user cannot
// write — a bind-mounted host directory keeps the host's ownership — with one
// actionable line, instead of letting every child crash-loop on a raw EACCES.

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRYPOINT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docker',
  'docker-entrypoint.sh',
);

function run(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile('sh', [ENTRYPOINT], { env: { ...process.env, ...env } }, (err, _out, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stderr });
    });
  });
}

let dir: string;
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

// root can write anywhere, so the refusal is unobservable as root.
describe.skipIf(process.getuid?.() === 0)('docker-entrypoint.sh state-dir check', () => {
  it('refuses an unwritable state dir with the chown fix, before running anything', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-entrypoint-'));
    chmodSync(dir, 0o555);
    const { code, stderr } = await run({ ETHOS_STATE_DIR: dir, ETHOS_PROVISION_FROM_ENV: '1' });
    expect(code).toBe(1);
    expect(stderr).toContain(`ethos: state dir ${dir}`);
    expect(stderr).toContain('is not writable by uid');
    expect(stderr).toContain('sudo chown -R');
    expect(stderr.trim().split('\n')).toHaveLength(1);
  });

  it('lets a writable state dir through to mode dispatch', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-entrypoint-'));
    // An unknown mode stops right after the check, without starting ethos.
    const { code, stderr } = await run({ ETHOS_STATE_DIR: dir, ETHOS_MODE: 'nope' });
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown ETHOS_MODE: nope');
    expect(stderr).not.toContain('not writable');
    // The write probe cleans up after itself.
    expect(readdirSync(dir)).toEqual([]);
  });
});
