// Ch.4d — Sandbox capability attestation.
//
// Declared as a type-only interface in @ethosagent/types so future
// TerminalBackend implementations (docker, modal, ssh, singularity,
// local) can return their attested capabilities without a circular
// dependency on the wiring layer. The plan's classifier-skip rule
// keys on the structured attestation, NOT the backend name string —
// that's what closes the "Docker with -v /:/host slips through because
// the label says docker" hole.
//
// **Status (v1):** the interface is defined and a `isStrictAttestation`
// helper is exported. NO backend currently implements `attest()` — the
// `TerminalBackend` abstraction itself doesn't exist in this repo yet.
// When it lands, each backend's factory's `create(config)` should
// derive the SandboxAttestation from the user's config so a misconfigured
// Docker (`-v /:/host`, `--privileged`, exposed docker socket) auto-falls
// back to classifier-on.
//
// Until then, the wiring layer treats every personality as
// "no attestation" and runs the classifier per the personality's
// `approvalMode` regardless of execution backend.

export interface SandboxAttestation {
  /** Root filesystem is read-only (overlayfs / mount ro). */
  readonlyRootFs: boolean;
  /** No bind mounts from the host (verified via container inspect). */
  noHostMounts: boolean;
  /** Outbound network filtered (allowlist or none). */
  egressControlled: boolean;
  /** /var/run/docker.sock NOT mounted — otherwise the container can
   *  spawn arbitrary host processes. */
  noDockerSocket: boolean;
  /** Running as a non-root uid in the container. */
  nonRoot: boolean;
  /** --privileged flag NOT set. */
  noPrivileged: boolean;
  /** No --cap-add flags beyond the Linux defaults. */
  noCapAdd: boolean;
  /** --cap-drop ALL is set. */
  capDropAll: boolean;
  /** --security-opt no-new-privileges set. */
  noNewPrivs: boolean;
}

/**
 * Strict = ALL nine confinement properties are true. Anything less is
 * "partial" and the per-call risk classifier stays enabled. The plan's
 * three-tier interaction:
 *
 *   strict   → 4a (hardline) only — sandbox IS the boundary
 *   partial  → 4a + 4c (classifier) + approval mode — treat as local
 *   absent   → 4a + 4c + approval mode — treat as local
 */
export function isStrictAttestation(a: SandboxAttestation): boolean {
  return (
    a.readonlyRootFs &&
    a.noHostMounts &&
    a.egressControlled &&
    a.noDockerSocket &&
    a.nonRoot &&
    a.noPrivileged &&
    a.noCapAdd &&
    a.capDropAll &&
    a.noNewPrivs
  );
}
