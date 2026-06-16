import { existsSync, readFileSync } from 'node:fs';
import {
  DockerExecutionBackend,
  resolveNetworkMode,
  scratchTmpfsFor,
} from '@ethosagent/execution-docker';
import { noopLogger } from '@ethosagent/logger';
import type {
  Constitution,
  DockerAbsentDecision,
  ExecutionPosture,
  Logger,
  MountSpec,
  PersonalityConfig,
} from '@ethosagent/types';

// Phase 2a, lane E1 — the FULL execution-posture resolver. Computes the
// legible `{ backend, networkMode, memoryMb, ... }` posture from the
// personality toolset + `fs_reach` + `safety.network` + the `execution:`
// override + containerized detection. Supersedes the minimal
// `resolve-execution-backend.ts` selector (which now delegates here so routed
// tools keep working).
//
// `node:fs` is used here ONLY to probe SYSTEM paths (`/.dockerenv`,
// `/proc/1/cgroup`) for in-container detection — NOT `~/.ethos`. The Storage
// abstraction governs `~/.ethos` access; these are kernel/runtime signals
// outside that boundary, so raw `node:fs` is the correct (and only) tool.

/** Default container memory ceiling (MB) — mirrors the docker backend default. */
const DEFAULT_MEMORY_MB = 256;

/**
 * Tool names that carry shell / code execution and therefore want a sandbox.
 * The personality `toolset` is a flat list of tool NAMES, not toolset groups:
 * `terminal`, the `process_*` family, and `run_code` are the exec-bearing
 * tools today.
 */
export function isExecTool(name: string): boolean {
  return name === 'terminal' || name === 'run_code' || name.startsWith('process_');
}

/** True when the personality has at least one execution-bearing tool. */
export function hasExecTool(personality: PersonalityConfig): boolean {
  return (personality.toolset ?? []).some(isExecTool);
}

/**
 * Read a defensively-typed `execution:` override off the personality config.
 * `execution` is NOT on the frozen PersonalityConfig type, so it's read off the
 * untyped surface and validated against the known posture names.
 */
function readExecutionOverride(
  personality: PersonalityConfig,
): 'docker' | 'local' | 'ssh' | 'none' | undefined {
  const raw = (personality as { execution?: unknown }).execution;
  if (raw === 'docker' || raw === 'local' || raw === 'ssh' || raw === 'none') return raw;
  return undefined;
}

/** Why the containerized posture was selected — for logging/character-sheet. */
export type ContainerizedSignal =
  | 'env:ETHOS_EXECUTION_BACKEND=local'
  | 'config:execution.containerized'
  | 'detect:/.dockerenv'
  | 'detect:/proc/1/cgroup'
  | 'detect:KUBERNETES_SERVICE_HOST';

export interface ContainerizedDetection {
  containerized: boolean;
  /** The signal that decided it (only set when `containerized` is true). */
  signal?: ContainerizedSignal;
  /** True when chosen explicitly (env/config) vs. auto-detected. */
  explicit: boolean;
}

export interface ContainerizedDetectionInput {
  /** `execution.containerized: true` from `~/.ethos/config.yaml`, if read by the caller. */
  containerizedConfig?: boolean;
  /** Injectable env (defaults to `process.env`) — keeps the probe testable. */
  env?: NodeJS.ProcessEnv;
  /** Injectable filesystem probes — keeps the probe testable without a container. */
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect whether Ethos itself runs inside a container, in which case the
 * surrounding container is ALREADY the isolation boundary and exec personalities
 * use the `local` backend (the container is the boundary). Precedence:
 *
 *   1. Explicit (highest): `ETHOS_EXECUTION_BACKEND=local` env or
 *      `execution.containerized: true` config — forces `local`.
 *   2. Auto-detect (overridable): `/.dockerenv`, a `docker`/`containerd` match
 *      in `/proc/1/cgroup`, or `KUBERNETES_SERVICE_HOST`.
 *
 * Never silent — the result is logged + shown on the character sheet by callers.
 */
export function detectContainerized(
  input: ContainerizedDetectionInput = {},
): ContainerizedDetection {
  const env = input.env ?? process.env;
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? defaultReadFile;

  // 1. Explicit env / config.
  if (env.ETHOS_EXECUTION_BACKEND === 'local') {
    return { containerized: true, signal: 'env:ETHOS_EXECUTION_BACKEND=local', explicit: true };
  }
  if (input.containerizedConfig === true) {
    return { containerized: true, signal: 'config:execution.containerized', explicit: true };
  }

  // 2. Auto-detect.
  if (fileExists('/.dockerenv')) {
    return { containerized: true, signal: 'detect:/.dockerenv', explicit: false };
  }
  const cgroup = readFile('/proc/1/cgroup');
  if (cgroup && /\b(docker|containerd)\b/.test(cgroup)) {
    return { containerized: true, signal: 'detect:/proc/1/cgroup', explicit: false };
  }
  if (env.KUBERNETES_SERVICE_HOST) {
    return { containerized: true, signal: 'detect:KUBERNETES_SERVICE_HOST', explicit: false };
  }

  return { containerized: false, explicit: false };
}

/** True when the constitution forbids the un-sandboxed `local` posture. */
export function constitutionForbidsLocal(constitution?: Constitution): boolean {
  const exec = constitution?.execution;
  return exec?.requireSandbox === true || exec?.forbidLocal === true;
}

export interface ResolveExecutionPostureInput {
  personality: PersonalityConfig;
  /** Operator constitution — gates the A1 `local` consent option (A4). */
  constitution?: Constitution;
  /** Containerized detection signals (env/config/filesystem probes). */
  containerized?: ContainerizedDetectionInput;
  /** Whether the Docker daemon is reachable — drives the A1 decision state. */
  dockerAvailable?: boolean;
  /**
   * Mount set for the docker posture, derived by the caller from the docker
   * backend's `mountsFor(personality)`. The resolver stays free of a docker
   * instance so it remains pure/testable. When absent, `mounts` is `[]`.
   */
  mounts?: MountSpec[];
  /** Container memory ceiling (MB). Defaults to 256. */
  memoryMb?: number;
  /** Optional log sink — containerized detection + A1 state are never silent. */
  log?: Logger;
}

/**
 * The full posture resolution rule:
 *
 *   - explicit `execution:` override wins (`docker`/`local`/`ssh`/`none`);
 *   - else chat-only (no exec tool) → `none` (`local` is NEVER silently
 *     assigned to a personality that never execs);
 *   - else exec-bearing → `docker` BY DEFAULT, UNLESS Ethos is containerized,
 *     in which case → `local` (the container is the boundary).
 *
 * When the resolved posture is `local` AND the constitution forbids it, the
 * caller (constitution layer / wiring) hard-fails the load — the resolver just
 * surfaces the posture and the A1 decision state; it never picks for the user
 * and never silently falls back.
 */
export function resolveExecutionPosture(input: ResolveExecutionPostureInput): ExecutionPosture {
  const {
    personality,
    constitution,
    dockerAvailable,
    mounts,
    memoryMb = DEFAULT_MEMORY_MB,
    log,
  } = input;

  const detection = detectContainerized(input.containerized);
  const override = readExecutionOverride(personality);
  const networkMode = resolveNetworkMode(personality);

  // Posture selection.
  let backend: ExecutionPosture['backend'];
  if (override) {
    backend = override;
  } else if (!hasExecTool(personality)) {
    backend = 'none';
  } else if (detection.containerized) {
    backend = 'local';
  } else {
    backend = 'docker';
  }

  if (detection.containerized && log) {
    log.info('execution posture: containerized → local backend', {
      personalityId: personality.id,
      signal: detection.signal,
      explicit: detection.explicit,
      backend,
    });
  }

  const derivedMounts = backend === 'docker' ? (mounts ?? []) : [];
  const scratchPaths = backend === 'docker' ? scratchTmpfsFor(derivedMounts) : [];

  const posture: ExecutionPosture = {
    backend,
    networkMode,
    memoryMb,
    containerized: backend === 'local' && detection.containerized,
    mounts: derivedMounts,
    scratchPaths,
  };

  // A1 — docker posture + daemon unavailable. Produce the typed decision state;
  // never a silent local fallback. The consent option is withheld when the
  // constitution forbids `local` (A4) — then it stays a hard error.
  if (backend === 'docker' && dockerAvailable === false) {
    const forbidsLocal = constitutionForbidsLocal(constitution);
    const decision: DockerAbsentDecision = {
      blocked: true,
      canInstall: true,
      canConsentLocal: !forbidsLocal,
    };
    if (forbidsLocal) {
      decision.consentForbiddenReason =
        'the constitution forbids the local posture (execution.requireSandbox / forbidLocal)';
    }
    posture.dockerAbsent = decision;
    if (log) {
      log.warn('execution posture: docker required but daemon unavailable (A1)', {
        personalityId: personality.id,
        canConsentLocal: decision.canConsentLocal,
      });
    }
  }

  return posture;
}

export interface BuildExecutionPostureInput {
  personality: PersonalityConfig;
  /** Operator constitution (gates the A1 consent option). */
  constitution?: Constitution;
  /** Containerized detection signals; defaults to probing `process.env` + fs. */
  containerized?: ContainerizedDetectionInput;
  /** Substitution roots for `fs_reach` mount derivation (`${ETHOS_HOME}`, `${CWD}`). */
  substitutionVars?: { ethosHome: string; cwd: string };
  /** Container memory ceiling (MB). Defaults to 256. */
  memoryMb?: number;
  /**
   * Probe for Docker daemon availability. When omitted, availability is NOT
   * checked (no A1 state) — surfaces that only render the static posture (CLI
   * `personality show`) pass nothing; surfaces that gate exec pass a real probe.
   */
  checkDockerAvailable?: () => Promise<boolean>;
  log?: Logger;
}

/**
 * High-level posture builder for read surfaces (CLI `personality show`, web
 * Personalities tab). Derives the `fs_reach` mount set through the docker
 * backend's `mountsFor` (the single source of truth for mount derivation),
 * then runs the posture resolver. `mountsFor` is pure — no daemon needed — so
 * this is safe to call even when Docker is absent.
 */
export async function buildExecutionPosture(
  input: BuildExecutionPostureInput,
): Promise<ExecutionPosture> {
  const detection = detectContainerized(input.containerized);
  const override = readExecutionOverride(input.personality);
  const wouldBeDocker =
    override === 'docker' ||
    (!override && !detection.containerized && hasExecTool(input.personality));

  let mounts: MountSpec[] = [];
  if (wouldBeDocker) {
    const backend = new DockerExecutionBackend({
      config: { substitutionVars: input.substitutionVars },
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: input.log ?? noopLogger,
    });
    mounts = backend.mountsFor(input.personality);
  }

  let dockerAvailable: boolean | undefined;
  if (wouldBeDocker && input.checkDockerAvailable) {
    dockerAvailable = await input.checkDockerAvailable();
  }

  return resolveExecutionPosture({
    personality: input.personality,
    constitution: input.constitution,
    containerized: input.containerized,
    mounts,
    memoryMb: input.memoryMb,
    dockerAvailable,
    log: input.log,
  });
}
