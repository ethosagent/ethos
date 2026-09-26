// S1 / D4 (plan openclaw-2026.9.6-gaps) — a goal's `command` acceptance check
// crosses the gates the `terminal` tool's path crosses, and runs only on the
// personality's resolved execution backend.

import type {
  ExecChunk,
  ExecutionBackend,
  ExecutionPosture,
  ExecutionRoute,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createAcceptanceCheckExecutor } from '../acceptance-check-executor';

function fakeBackend(
  name: string,
  code = 0,
): ExecutionBackend & { exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(async function* (): AsyncIterable<ExecChunk> {
    yield { stream: 'stdout', data: 'ok\n' } as ExecChunk;
    yield { stream: 'exit', code } as ExecChunk;
  });
  return { name, exec } as unknown as ExecutionBackend & { exec: ReturnType<typeof vi.fn> };
}

const posture = (backend: ExecutionPosture['backend']): ExecutionPosture =>
  ({ backend, containerized: false }) as ExecutionPosture;

function executor(opts: {
  person: PersonalityConfig;
  backend: ExecutionPosture['backend'];
  route: ExecutionRoute;
  host?: ExecutionBackend;
}) {
  const hostBackend = vi.fn(async () => opts.host ?? fakeBackend('local'));
  const exec = createAcceptanceCheckExecutor({
    personalities: { get: (id) => (id === opts.person.id ? opts.person : undefined) },
    route: async () => opts.route,
    postureFor: () => posture(opts.backend),
    hostBackend,
    workingDir: '/work',
  });
  return { exec, hostBackend };
}

const withTerminal: PersonalityConfig = { id: 'eng', name: 'eng', toolset: ['terminal'] };

describe('createAcceptanceCheckExecutor', () => {
  it('D4 — refuses a command check for a personality without terminal', async () => {
    const docker = fakeBackend('docker');
    const { exec } = executor({
      person: { id: 'writer', name: 'writer', toolset: ['read_file', 'goal_create'] },
      backend: 'docker',
      route: { backend: docker, hostExecForbidden: false },
    });
    await expect(exec('touch /tmp/x', { personalityId: 'writer' })).rejects.toThrow(
      /does not hold the terminal tool/,
    );
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('refuses a hardline command before any backend is touched', async () => {
    const docker = fakeBackend('docker');
    const { exec } = executor({
      person: withTerminal,
      backend: 'docker',
      route: { backend: docker, hostExecForbidden: false },
    });
    await expect(exec('rm -rf /', { personalityId: 'eng' })).rejects.toThrow(
      /recursive force-delete/,
    );
    await expect(exec("bash -c 'id'", { personalityId: 'eng' })).rejects.toThrow(/sh -c/);
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('refuses a command a personality deny rule matches', async () => {
    const docker = fakeBackend('docker');
    const { exec } = executor({
      person: { ...withTerminal, safety: { denyRules: ['curl'] } },
      backend: 'docker',
      route: { backend: docker, hostExecForbidden: false },
    });
    await expect(exec('curl https://x.example', { personalityId: 'eng' })).rejects.toThrow(
      /deny rule: curl/,
    );
  });

  it('under a host-local posture the command needs approval nobody can give — refused, host untouched', async () => {
    const { exec, hostBackend } = executor({
      person: withTerminal,
      backend: 'local',
      route: { hostExecForbidden: false },
    });
    await expect(exec('pnpm test', { personalityId: 'eng' })).rejects.toThrow(
      /terminal requires explicit approval/,
    );
    expect(hostBackend).not.toHaveBeenCalled();
  });

  it('under a docker posture the injected backend runs the command', async () => {
    const docker = fakeBackend('docker', 3);
    const { exec, hostBackend } = executor({
      person: withTerminal,
      backend: 'docker',
      route: { backend: docker, hostExecForbidden: false, personality: withTerminal },
    });
    expect(await exec('pnpm test', { personalityId: 'eng' })).toEqual({
      code: 3,
      stdout: 'ok\n',
      stderr: '',
    });
    expect(docker.exec).toHaveBeenCalledWith(
      'pnpm test',
      expect.objectContaining({ cwd: '/work', env: {}, personality: withTerminal }),
    );
    expect(hostBackend).not.toHaveBeenCalled();
  });

  it('a route that forbids host execution refuses in its own words', async () => {
    const { exec } = executor({
      person: withTerminal,
      backend: 'docker',
      route: { hostExecForbidden: true, hostExecForbiddenMessage: 'no sandbox here' },
    });
    await expect(exec('pnpm test', { personalityId: 'eng' })).rejects.toThrow(/no sandbox here/);
  });
});
