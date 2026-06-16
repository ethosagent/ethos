import type { PersonalityConfig } from './personality';

export type ExecChunk =
  | { stream: 'stdout' | 'stderr'; data: string }
  /**
   * Terminal chunk carrying the command's exit code. Emitted as the LAST chunk
   * of a naturally-completed exec stream (after all stdout/stderr). Backends do
   * NOT emit it when the stream ends via timeout/abort — those throw instead.
   * Consumers that ignore exit codes can skip this variant (`data` is absent).
   */
  | { stream: 'exit'; code: number };

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
  /**
   * Personality whose `fs_reach` derives the container mount set (docker
   * backend). Routed execution tools pass this so the OS-layer mount boundary
   * matches the personality's declared reach. Ignored by `local`/`ssh`.
   */
  personality?: PersonalityConfig;
  /**
   * Session lane key. The lifecycle manager (SessionManager) keys persistent
   * exec sessions by (personality.id, sessionId). When absent, all execs for a
   * personality share a single default lane (sessionId defaults to '').
   */
  sessionId?: string;
}

export interface ExecSession {
  readonly personalityId: string;
  exec(cmd: string, opts?: ExecOpts): AsyncIterable<ExecChunk>;
  /**
   * Signal the in-session process(es). For the docker backend this signals the
   * containerized process (the boundary owns the real pid; the host never sees
   * it). Optional: backends without a real in-session pid (local/ssh thin
   * sessions) may omit it, in which case callers fall back to `dispose()`.
   */
  stop?(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  dispose(): Promise<void>;
}

export interface MountSpec {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
}

/**
 * The resolved, legible execution posture of a personality (Phase 2a, lane E1).
 * Computed from the personality toolset + `fs_reach` + `safety.network` + any
 * `execution:` override + containerized detection — not hand-set. Surfaced
 * read-only on the character sheet's `## Execution` section, identically on CLI
 * and the web Personalities tab. Additive contract — not a frozen schema.
 */
export interface ExecutionPosture {
  /**
   * `docker` — exec-bearing toolset runs OS-mount-confined in a container.
   * `local` — runs in the current process (containerized posture, or explicit
   *   un-sandboxed consent); the host/container is the boundary.
   * `ssh` — runs on a remote host; remote-host trust, NOT mount-confinement.
   * `none` — chat-only personality; no execution backend at all.
   */
  backend: 'docker' | 'local' | 'ssh' | 'none';
  /** OS-layer container network gate. `none` = air-gapped; `bridge` = open egress. */
  networkMode: 'none' | 'bridge';
  /** Container memory ceiling in MB (docker). */
  memoryMb: number;
  /**
   * True when `local` was selected because Ethos itself runs inside a container
   * (explicit env/config or auto-detect) — the container is the boundary,
   * `fs_reach`/network enforced app-layer only. Distinct from the forbidden
   * daemon-down fallback.
   */
  containerized: boolean;
  /** Bind mounts derived from `fs_reach` (docker posture). Empty otherwise. */
  mounts: MountSpec[];
  /** Ephemeral tmpfs scratch container paths (docker posture), e.g. `/tmp`. */
  scratchPaths: string[];
  /**
   * A1 docker-absent decision state. Present ONLY when posture is `docker` and
   * the daemon is unavailable. Drives the E2 modal — never a silent fallback.
   */
  dockerAbsent?: DockerAbsentDecision;
}

/**
 * A1 (review correction) — the typed choice surfaced when a `docker`-posture
 * personality cannot reach the Docker daemon. NO silent host fallback. Exposed
 * for the E2 UI to render; the resolver never picks for the user.
 */
export interface DockerAbsentDecision {
  /** Always true when this object is present. */
  blocked: true;
  /** Guided-install option is always offered. */
  canInstall: true;
  /**
   * Whether an explicit un-sandboxed `local` consent may be offered. False when
   * the constitution forbids `local` (`requireSandbox` / `forbidLocal`) — then
   * it stays a hard error with no consent escape hatch.
   */
  canConsentLocal: boolean;
  /** Human-readable reason the consent option is withheld, when it is. */
  consentForbiddenReason?: string;
}

export interface ExecutionBackend {
  readonly name: string; // 'local' | 'docker' | 'ssh'
  isAvailable(): Promise<boolean>;
  exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk>;
  spawnSession(personalityId: string): ExecSession;
  mountsFor(p: PersonalityConfig): MountSpec[];
  dispose(): Promise<void>;
}

export interface ExecutionBackendConfig {
  /** Runtime image refs pinned by @sha256: digest (review #2). Keyed by logical runtime name. */
  images?: Record<string, string>;
  /** Default container memory cap in MB (docker). */
  memoryMb?: number;
  /** ssh target — remote-host trust, NOT mount-confinement (review A3). */
  ssh?: { host: string; user?: string; port?: number; identityFile?: string };
  /**
   * Substitution roots for resolving `${ETHOS_HOME}` and `${CWD}` in
   * `fs_reach` before deriving mounts. `${self}` resolves to the personality
   * id at `mountsFor` time. When absent, the docker backend falls back to
   * `~/.ethos` and `process.cwd()`.
   */
  substitutionVars?: { ethosHome: string; cwd: string };
}

export type ExecutionBackendFactory = (ctx: {
  config: ExecutionBackendConfig;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}) => ExecutionBackend | Promise<ExecutionBackend>;

export interface ExecutionBackendRegistry {
  register(name: string, factory: ExecutionBackendFactory): void;
  /** Resolve (and cache) a registered factory into a concrete backend instance. */
  resolve(
    name: string,
    ctx: {
      config: ExecutionBackendConfig;
      secrets: import('./secrets').SecretsResolver;
      logger: import('./logger').Logger;
    },
  ): Promise<ExecutionBackend>;
  get(name: string): ExecutionBackend | undefined;
  list(): string[];
}
