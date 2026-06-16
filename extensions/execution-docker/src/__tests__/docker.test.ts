// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecChunk,
  ExecutionBackendConfig,
  Logger,
  PersonalityConfig,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildDockerArgs,
  DockerExecutionBackend,
  DockerUnavailableError,
  ForbiddenMountError,
  InvalidImageRefError,
  withByteCeiling,
} from '../index';

const secretsStub: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const loggerStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => loggerStub,
};

describe('buildDockerArgs', () => {
  it('includes hardening flags, non-root user, and digest-pinned image', () => {
    const args = buildDockerArgs({
      image: 'python@sha256:abc123',
      uid: 1000,
      gid: 1000,
      memoryMb: 256,
      networkMode: 'none',
      stdin: false,
      cmd: 'echo hi',
      containerName: 'x',
    });
    for (const expected of [
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '2',
      '--pids-limit',
      '256',
      '--memory=256m',
      '--memory-swap',
      '256m',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--pull=never',
      'python@sha256:abc123',
    ]) {
      expect(args).toContain(expected);
    }
  });

  it('throws InvalidImageRefError when the image is not digest-pinned', () => {
    expect(() =>
      buildDockerArgs({
        image: 'python:3.12-slim',
        uid: 1000,
        gid: 1000,
        memoryMb: 256,
        networkMode: 'none',
        stdin: false,
        cmd: 'echo hi',
        containerName: 'x',
      }),
    ).toThrow(InvalidImageRefError);
  });

  it('accepts a digest-pinned image and includes the ref plus --pull=never', () => {
    const args = buildDockerArgs({
      image: 'python@sha256:def456',
      uid: 1000,
      gid: 1000,
      memoryMb: 256,
      networkMode: 'none',
      stdin: false,
      cmd: 'echo hi',
      containerName: 'x',
    });
    expect(args).toContain('python@sha256:def456');
    expect(args).toContain('--pull=never');
  });
});

// ---------------------------------------------------------------------------
// mountsFor — fs_reach → mounts (review d, A2, A7, invariant)
// ---------------------------------------------------------------------------

const ETHOS_HOME = '/home/u/.ethos';
const CWD = '/work/project';

function makeBackend(fsReach?: PersonalityConfig['fs_reach'], id = 'tester') {
  const config: ExecutionBackendConfig = {
    images: { default: 'x@sha256:abc' },
    substitutionVars: { ethosHome: ETHOS_HOME, cwd: CWD },
  };
  const be = new DockerExecutionBackend(
    { config, secrets: secretsStub, logger: loggerStub },
    async () => false,
  );
  const p = { id, name: id, fs_reach: fsReach } as unknown as PersonalityConfig;
  return { be, p };
}

describe('mountsFor', () => {
  it('maps read[] → ro and write[] → rw with hostPath === containerPath', () => {
    const { be, p } = makeBackend({ read: ['/data/in'], write: ['/data/out'] });
    const mounts = be.mountsFor(p);
    expect(mounts).toContainEqual({ hostPath: '/data/in', containerPath: '/data/in', mode: 'ro' });
    expect(mounts).toContainEqual({
      hostPath: '/data/out',
      containerPath: '/data/out',
      mode: 'rw',
    });
  });

  it('resolves ${ETHOS_HOME}, ${self}, ${CWD} substitutions before deriving mounts', () => {
    const { be, p } = makeBackend(
      { read: ['${ETHOS_HOME}/skills', '${CWD}'], write: ['${ETHOS_HOME}/personalities/${self}'] },
      'alice',
    );
    const paths = be.mountsFor(p).map((m) => m.hostPath);
    expect(paths).toContain(`${ETHOS_HOME}/skills`);
    expect(paths).toContain(CWD);
    expect(paths).toContain(`${ETHOS_HOME}/personalities/alice`);
  });

  it('keeps BOTH a ro parent and a rw child (child wins in its subtree)', () => {
    const { be, p } = makeBackend({ read: ['/repo'], write: ['/repo/build'] });
    const mounts = be.mountsFor(p);
    expect(mounts).toContainEqual({ hostPath: '/repo', containerPath: '/repo', mode: 'ro' });
    expect(mounts).toContainEqual({
      hostPath: '/repo/build',
      containerPath: '/repo/build',
      mode: 'rw',
    });
  });

  it('rw wins when the same exact path is both ro and rw (write subsumes read)', () => {
    const { be, p } = makeBackend({ read: ['/shared'], write: ['/shared'] });
    const mounts = be.mountsFor(p).filter((m) => m.hostPath === '/shared');
    expect(mounts).toEqual([{ hostPath: '/shared', containerPath: '/shared', mode: 'rw' }]);
  });

  it('dedups identical (path, mode) specs', () => {
    const { be, p } = makeBackend({ read: ['/a', '/a'], write: ['/keep'] });
    const mounts = be.mountsFor(p).filter((m) => m.hostPath === '/a');
    expect(mounts).toHaveLength(1);
  });

  // A2 — built-in critical denylist, INDEPENDENT of any constitution (none here).
  it.each([
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/proc',
    '/sys',
    '/dev',
    '/proc/self',
    '/dev/mem',
    '/sys/kernel',
  ])('refuses to mount forbidden path %s (ForbiddenMountError, no constitution)', (path) => {
    const { be, p } = makeBackend({ read: [path] });
    expect(() => be.mountsFor(p)).toThrow(ForbiddenMountError);
  });

  it('also refuses a forbidden path declared as write', () => {
    const { be, p } = makeBackend({ write: ['/proc/sys'] });
    expect(() => be.mountsFor(p)).toThrow(ForbiddenMountError);
  });

  // CI invariant: derived host-mount path set ≡ resolved fs_reach path set
  // (exactly), AFTER per-list defaults are filled — mirroring ScopedStorage,
  // which applies the read/write defaults independently per list.
  describe('invariant: mounts ≡ resolved fs_reach', () => {
    const OWN = `${ETHOS_HOME}/personalities/bob`;
    const SKILLS = `${ETHOS_HOME}/skills`;
    const READ_DEFAULT = [OWN, SKILLS, CWD];
    const WRITE_DEFAULT = [OWN, CWD];

    const shapes: Array<{ name: string; reach: PersonalityConfig['fs_reach'] }> = [
      { name: 'read-only', reach: { read: ['/r1', '/r2'] } },
      { name: 'write-only', reach: { write: ['/w1'] } },
      { name: 'mixed', reach: { read: ['/r'], write: ['/w'] } },
      { name: 'nested', reach: { read: ['/repo'], write: ['/repo/out'] } },
      {
        name: 'with substitution tokens',
        reach: { read: ['${ETHOS_HOME}/skills', '${CWD}'], write: ['${ETHOS_HOME}/x/${self}'] },
      },
    ];
    it.each(shapes)('$name', ({ reach }) => {
      const { be, p } = makeBackend(reach, 'bob');
      const mounts = be.mountsFor(p);
      const sub = (s: string) =>
        s
          .replace(/\$\{ETHOS_HOME\}/g, ETHOS_HOME)
          .replace(/\$\{self\}/g, 'bob')
          .replace(/\$\{CWD\}/g, CWD);
      const readResolved = reach?.read?.length ? reach.read.map(sub) : READ_DEFAULT;
      const writeResolved = reach?.write?.length ? reach.write.map(sub) : WRITE_DEFAULT;
      const expected = new Set([...readResolved, ...writeResolved]);
      const got = new Set(mounts.map((m) => m.hostPath));
      expect(got).toEqual(expected);
      // Ephemeral scratch is NOT a host mount and must never appear here.
      expect(got.has('/tmp')).toBe(false);
      expect(got.has('/home/sandbox')).toBe(false);
    });
  });

  it('applies ScopedStorage defaults when fs_reach is unset', () => {
    const { be, p } = makeBackend(undefined, 'carol');
    const paths = be.mountsFor(p).map((m) => m.hostPath);
    expect(paths).toContain(`${ETHOS_HOME}/personalities/carol`);
    expect(paths).toContain(`${ETHOS_HOME}/skills`);
    expect(paths).toContain(CWD);
  });
});

// ---------------------------------------------------------------------------
// buildDockerArgs — mounts + ephemeral scratch (review #5) + clean env (#3)
// ---------------------------------------------------------------------------

describe('buildDockerArgs mounts + scratch + env', () => {
  it('emits -v flags for host mounts and --tmpfs for ephemeral scratch (#5)', () => {
    const args = buildDockerArgs({
      image: 'x@sha256:abc',
      uid: 1000,
      gid: 1000,
      memoryMb: 256,
      networkMode: 'none',
      stdin: false,
      cmd: 'echo hi',
      containerName: 'x',
      mounts: [{ hostPath: '/data', containerPath: '/data', mode: 'ro' }],
      tmpfs: ['/tmp', '/home/sandbox'],
    });
    expect(args).toContain('-v');
    expect(args).toContain('/data:/data:ro');
    // tmpfs is writable + ephemeral; appears as --tmpfs, NOT as a -v host mount.
    const tmpfsCount = args.filter((a) => a === '--tmpfs').length;
    expect(tmpfsCount).toBe(2);
    expect(args).toContain('/tmp');
    expect(args).toContain('/home/sandbox');
    expect(args).not.toContain('/tmp:/tmp');
  });

  it('forwards no host secrets when env is empty (#3)', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    try {
      const args = buildDockerArgs({
        image: 'x@sha256:abc',
        uid: 1000,
        gid: 1000,
        memoryMb: 256,
        networkMode: 'none',
        stdin: false,
        cmd: 'printenv',
        containerName: 'x',
        env: {},
      });
      expect(args.join(' ')).not.toContain('ANTHROPIC_API_KEY');
      expect(args.join(' ')).not.toContain('sk-secret');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// withByteCeiling — output byte ceiling (review #6)
// ---------------------------------------------------------------------------

describe('withByteCeiling', () => {
  it('kills the exec and emits a truncation marker once the ceiling is exceeded', async () => {
    let killed = false;
    async function* infinite(): AsyncIterable<ExecChunk> {
      // Each chunk is 100 bytes; ceiling 250 → stops after the third chunk.
      for (let i = 0; i < 1000; i++) {
        yield { stream: 'stdout', data: 'x'.repeat(100) };
      }
    }
    const out: ExecChunk[] = [];
    for await (const c of withByteCeiling(infinite(), 250, () => {
      killed = true;
    })) {
      out.push(c);
    }
    expect(killed).toBe(true);
    const last = out[out.length - 1];
    expect(last?.stream).toBe('stderr');
    expect(last && last.stream !== 'exit' ? last.data : '').toMatch(
      /\[output truncated at 250 bytes\]/,
    );
    // The stream stopped — far fewer than 1000 chunks were yielded.
    expect(out.length).toBeLessThan(10);
  });

  it('passes through under the ceiling without a marker', async () => {
    async function* small(): AsyncIterable<ExecChunk> {
      yield { stream: 'stdout', data: 'hello' };
    }
    const out: ExecChunk[] = [];
    for await (const c of withByteCeiling(small(), 1000, () => {})) out.push(c);
    expect(out).toEqual([{ stream: 'stdout', data: 'hello' }]);
  });
});

// ---------------------------------------------------------------------------
// Red-team escape (docker-gated). Skips cleanly when the daemon is absent so
// Node-24-no-docker CI passes. Requires a digest-pinned image in
// ETHOS_TEST_DOCKER_IMAGE (e.g. busybox@sha256:...) to actually run a
// container — skipped otherwise to avoid --pull=never flakiness.
// ---------------------------------------------------------------------------

async function dockerInfoOk(): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  return new Promise<boolean>((resolve) => {
    try {
      const c = spawn('docker', ['info'], { stdio: 'ignore' });
      c.on('close', (code) => resolve(code === 0));
      c.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

const dockerAvailable = await dockerInfoOk();
const testImage = process.env.ETHOS_TEST_DOCKER_IMAGE;

describe.skipIf(!dockerAvailable || !testImage)('red-team escape (docker-gated)', () => {
  it('a docker-backed shell cannot cat a path outside the mount set', async () => {
    const config: ExecutionBackendConfig = {
      images: { default: testImage as string },
      substitutionVars: { ethosHome: ETHOS_HOME, cwd: CWD },
    };
    const be = new DockerExecutionBackend({ config, secrets: secretsStub, logger: loggerStub });
    const personality = {
      id: 'redteam',
      name: 'redteam',
      fs_reach: { read: ['/tmp'] },
    } as unknown as PersonalityConfig;
    let combined = '';
    for await (const chunk of be.exec('cat /etc/hostname 2>&1 || echo DENIED', {
      personality,
      timeoutMs: 20_000,
    })) {
      if (chunk.stream !== 'exit') combined += chunk.data;
    }
    // /etc was never mounted; the read must fail (file absent inside the sandbox).
    expect(combined).toMatch(/DENIED|No such file|cannot open/i);
  });
});

describe('DockerExecutionBackend', () => {
  it('throws DockerUnavailableError without falling back to local', async () => {
    const be = new DockerExecutionBackend(
      {
        config: { images: { default: 'python@sha256:abc' } },
        secrets: secretsStub,
        logger: loggerStub,
      },
      async () => false,
    );
    await expect(
      (async () => {
        for await (const _ of be.exec('echo hi', {})) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(DockerUnavailableError);
  });
});

describe.skipIf(!dockerAvailable || !testImage)('persistent session (docker-gated)', () => {
  // These tests are docker-gated: they only run when docker is available and
  // ETHOS_TEST_DOCKER_IMAGE is set. They verify cwd/env persistence across
  // exec calls on a single persistent session, opportunistically.
  it('cwd persists across exec calls', async () => {
    const config: ExecutionBackendConfig = {
      images: { default: testImage as string },
      substitutionVars: { ethosHome: ETHOS_HOME, cwd: CWD },
    };
    const be = new DockerExecutionBackend({ config, secrets: secretsStub, logger: loggerStub });
    const session = be.spawnSession('redteam');
    const personality = {
      id: 'redteam',
      name: 'redteam',
      fs_reach: { read: ['/tmp'] },
    } as unknown as PersonalityConfig;
    const drain = async (cmd: string) => {
      let out = '';
      for await (const c of session.exec(cmd, { personality, timeoutMs: 20_000 }))
        if (c.stream !== 'exit') out += c.data;
      return out;
    };
    await drain('cd /tmp');
    const pwd = await drain('pwd');
    await session.dispose();
    expect(pwd).toMatch(/\/tmp/);
  });
  it('env vars persist across exec calls', async () => {
    const config: ExecutionBackendConfig = {
      images: { default: testImage as string },
      substitutionVars: { ethosHome: ETHOS_HOME, cwd: CWD },
    };
    const be = new DockerExecutionBackend({ config, secrets: secretsStub, logger: loggerStub });
    const session = be.spawnSession('redteam');
    const personality = {
      id: 'redteam',
      name: 'redteam',
      fs_reach: { read: ['/tmp'] },
    } as unknown as PersonalityConfig;
    const drain = async (cmd: string) => {
      let out = '';
      for await (const c of session.exec(cmd, { personality, timeoutMs: 20_000 }))
        if (c.stream !== 'exit') out += c.data;
      return out;
    };
    await drain('export FOO=bar');
    const echoed = await drain('echo $FOO');
    await session.dispose();
    expect(echoed).toMatch(/bar/);
  });

  it('surfaces the exit code as a terminal exit chunk (Lane C2)', async () => {
    // Point substitution roots at real, existing host dirs so mountsFor derives
    // only mountable paths (the synthetic /home/u/.ethos + /work/project of the
    // other tests don't exist on this host; their defaults can't bind-mount).
    const mountDir = mkdtempSync(join(tmpdir(), 'ethos-rc-'));
    const config: ExecutionBackendConfig = {
      images: { default: testImage as string },
      substitutionVars: { ethosHome: mountDir, cwd: mountDir },
    };
    const be = new DockerExecutionBackend({ config, secrets: secretsStub, logger: loggerStub });
    const session = be.spawnSession('rc');
    const personality = {
      id: 'rc',
      name: 'rc',
      fs_reach: { read: [mountDir], write: [mountDir] },
    } as unknown as PersonalityConfig;
    const exitCodeOf = async (cmd: string): Promise<number | undefined> => {
      let code: number | undefined;
      for await (const c of session.exec(cmd, { personality, timeoutMs: 20_000 })) {
        if (c.stream === 'exit') code = c.code;
      }
      return code;
    };
    expect(await exitCodeOf('true')).toBe(0);
    // Use a subshell: a bare `exit 5` would terminate the persistent shell
    // itself (and thus the session), not just the command.
    expect(await exitCodeOf('(exit 5)')).toBe(5);
    await session.dispose();
    rmSync(mountDir, { recursive: true, force: true });
  });

  it('orders per-command stderr within the same exec and bounds it to the command', async () => {
    const mountDir = mkdtempSync(join(tmpdir(), 'ethos-order-'));
    const config: ExecutionBackendConfig = {
      images: { default: testImage as string },
      substitutionVars: { ethosHome: mountDir, cwd: mountDir },
    };
    const be = new DockerExecutionBackend({ config, secrets: secretsStub, logger: loggerStub });
    const session = be.spawnSession('order');
    const personality = {
      id: 'order',
      name: 'order',
      fs_reach: { read: [mountDir], write: [mountDir] },
    } as unknown as PersonalityConfig;
    const collect = async (cmd: string) => {
      let stdout = '';
      let stderr = '';
      for await (const c of session.exec(cmd, { personality, timeoutMs: 20_000 })) {
        if (c.stream === 'stdout') stdout += c.data;
        else if (c.stream === 'stderr') stderr += c.data;
      }
      return { stdout, stderr };
    };
    const first = await collect('echo OUT1; echo ERR1 >&2');
    expect(first.stdout).toContain('OUT1');
    expect(first.stderr).toContain('ERR1');
    // The next command's stderr must NOT contain the previous command's stderr.
    const second = await collect('echo OUT2');
    expect(second.stderr).not.toContain('ERR1');
    await session.dispose();
    rmSync(mountDir, { recursive: true, force: true });
  });
});
