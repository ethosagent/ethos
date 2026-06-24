import type { EthosPlugin, EthosPluginApi, ExecutionBackendFactory } from '@ethosagent/plugin-sdk';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  MountSpec,
  PersonalityConfig,
  SandboxAttestation,
} from '@ethosagent/types';

/**
 * Skeleton execution backend — replace with your implementation.
 *
 * An ExecutionBackend translates "run this command" into a concrete runtime:
 * a container, a VM, a remote host, a cloud sandbox, etc.
 *
 * Key contract points:
 * - exec() must end with { stream: 'exit', code: number } on natural completion
 * - attest() must honestly reflect the backend's confinement capabilities
 * - Credentials come from SecretsResolver, never from config values
 * - mountsFor() returns bind mounts derived from the personality's fs_reach
 */
class MyExecutionBackend implements ExecutionBackend {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async isAvailable(): Promise<boolean> {
    // Return true if this backend's runtime is reachable.
    throw new Error('Not implemented');
  }

  // biome-ignore lint/correctness/useYield: skeleton — replace with real implementation
  async *exec(_cmd: string, _opts: ExecOpts): AsyncIterable<ExecChunk> {
    // Stream stdout/stderr chunks, then emit { stream: 'exit', code } at the end.
    throw new Error('Not implemented');
  }

  spawnSession(personalityId: string): ExecSession {
    // Return a persistent session that can run multiple commands.
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => this.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    };
  }

  mountsFor(_p: PersonalityConfig): MountSpec[] {
    // Derive container/VM mounts from the personality's fs_reach.
    // Return [] if this backend doesn't support mount confinement.
    return [];
  }

  attest(): SandboxAttestation {
    // Honestly declare this backend's confinement capabilities.
    // The framework keys the classifier-skip on isStrictAttestation(attest()),
    // NEVER on the backend name. A partial attestation keeps the classifier on.
    return {
      readonlyRootFs: false,
      noHostMounts: false,
      egressControlled: false,
      noDockerSocket: false,
      nonRoot: false,
      noPrivileged: false,
      noCapAdd: false,
      capDropAll: false,
      noNewPrivs: false,
    };
  }

  async dispose(): Promise<void> {
    // Clean up resources (containers, connections, etc.)
  }
}

const factory: ExecutionBackendFactory = ({
  config: _config,
  secrets: _secrets,
  logger: _logger,
}) => {
  return new MyExecutionBackend('my-backend');
};

const plugin: EthosPlugin = {
  activate(api: EthosPluginApi) {
    api.registerExecutionBackend('my-backend', factory);
  },
};

export default plugin;
