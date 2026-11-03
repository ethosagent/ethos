---
title: "Security controls: filesystem controls"
description: "ScopedStorage, BoundaryError, symlink handling and the bash boundary."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

ScopedStorage and BoundaryError, symlink-misdirection handling and the bash plus filesystem boundary. Part of the [Security controls](../controls.md).

## Filesystem controls {#filesystem-controls}

### ScopedStorage and BoundaryError {#scoped-storage-and-boundary-error}

*Status: Shipped (file-tool and storage boundaries). Not covered (a global guarantee that every `~/.ethos/` access is scoped).*

A personality's filesystem reach is its `fs_reach` allowlist plus a global always-deny floor for sensitive paths (`.ssh`, `.aws/credentials`, `/etc/passwd`, and similar). Two decorators enforce it:

| Decorator | Guards | Refusal |
|---|---|---|
| `ScopedFsImpl` (`packages/core/src/scoped/scoped-fs.ts`), built from `fs_reach` in `packages/core/src/capability-resolver.ts` | The file tools' `ctx.scopedFs` | `Error` whose message starts `PATH_NOT_REACHABLE:`; the file tool turns it into a tool error |
| `ScopedStorage` (`packages/storage-fs/src/scoped-storage.ts`) | A `Storage` handed to a personality-scoped consumer | `BoundaryError`, which the surface turns into a tool error |

Not every read or write under `~/.ethos/` goes through either decorator. The SQLite stores, locks, the backup engine and the other modules on the raw-`node:fs` carve-out list in `CLAUDE.md` open paths directly; they are framework code, not tool reach.

- Cross-personality isolation tests: `extensions/tools-file/src/__tests__/boundary.test.ts` (for example, `researcher CANNOT read engineer's MEMORY.md`)
- Audit: a reach refusal is returned to the model as a tool error. No audit event is written for it.

### Symlink-misdirection handling {#symlink-misdirection-handling}

*Status: Shipped (misdirection defense). Not covered (check-then-open race).*

The reach check does two things. First it normalises the path lexically — `normalize(resolve(path))` — so `..`, `.`, and redundant-slash traversal cannot walk out of an allowed prefix. Then, for a path already inside the reach, it walks **every segment** below the matched prefix with `lstat`. When it finds a symbolic link, it **follows** it and re-judges the deny floor and the allowlist against where the link lands, up to `MAX_SYMLINK_HOPS` (32) links.

| Link | Outcome |
|---|---|
| Lands outside the allowlist, e.g. `<allowed>/notes.md → ~/.ssh/id_rsa` | Refused at the link, before anything opens the target |
| Lands on the always-deny floor | Refused |
| Lands inside the allowlist | Allowed (`ALLOWS a symlink whose target is inside the allowlist` in `boundary.test.ts`) |
| Chain longer than 32 links | Refused |

The walk is per-segment rather than leaf-only because **a symlinked parent escapes with a non-symlink leaf**: `<allowed>/data → /etc` makes `<allowed>/data/passwd` an ordinary file whose link path passes any prefix test.

Normalisation alone does not close this. `resolve()` is a string operation and a symlink is a filesystem fact — the lexically-resolved link path is neither under a denied prefix nor outside the allowed one, so it passes the always-deny floor and the allow check both. The segment walk is what re-judges where the read actually lands.

The same walk exists as four hand-maintained copies, because the layer model stops them sharing code. All four follow a link, refuse an escape, and fail closed when a segment cannot be `lstat`ed for any reason other than not existing:

| Copy | Guards |
|---|---|
| `ScopedFsImpl.checkReach` (`packages/core/src/scoped/scoped-fs.ts`) | File tools |
| `ScopedStorage.check` (`packages/storage-fs/src/scoped-storage.ts`) | Scoped `Storage` |
| `containedPath` / `followFirstSymlink` (`packages/wiring/src/backup/restore.ts`) | Backup restore destinations |
| `DocumentsService.reachable` (`apps/web-api/src/services/documents.service.ts`) | The web Documents root |

A fix to one copy that is not applied to the others leaves the escape open on whichever path the caller takes. The comment above `followFirstSymlink` in `scoped-fs.ts` records the rule that all four change together.

What this does **not** close is the check-then-open race: an attacker who can swap a path between the walk and the `open()` can still redirect the read. Closing it needs `openat`-style directory handles with no-follow semantics, which Node does not expose. No code addresses it; treat it as container-level remediation.

- Tests: `extensions/tools-file/src/__tests__/boundary.test.ts`; `apps/web-api/src/__tests__/services/documents.service.fail-closed.test.ts` (the Documents copy refuses on any `lstat` error other than `ENOENT`)
- History: this defense was originally implemented as a path-canonicalisation call inside the file tools and was dropped during a refactor that centralised normalisation at the boundary, without this page being updated. See [Pre-launch hardening pass, entry 8](.././security-fixes.md#8-symlink-misdirection) for the dated correction.

### Bash + filesystem boundary {#bash-filesystem-boundary}

*Status: Shipped (execution-posture gating). Not shipped (a config-load gate on sandbox attestation).*

There is no tool named `bash`; the shell tool is `terminal`. What stops a personality with shell access from running unconfined on the host is the resolved execution posture, not an attestation check.

| Situation | Outcome | Enforced by |
|---|---|---|
| Personality holds an exec tool, host is not containerized | Posture is `docker` | `resolveExecutionPosture` in `packages/wiring/src/resolve-execution-posture.ts` |
| Docker cannot be built in this process | Refused, unless the operator sets `execution.allowLocalFallback: true`; then an honestly labelled `local` posture | `resolveExecutionPosture` (`fallbackToLocal`) |
| The operator constitution sets `execution.requireSandbox` or `execution.forbidLocal` | The `local` posture is refused | `constitutionForbidsLocal` |
| Personality runs on a host-local posture | `terminal`, `process_start`, `run_tests` and `lint` need approval in every mode | `LOCAL_POSTURE_CONSEQUENTIAL_TOOLS` in `packages/wiring/src/danger-predicate.ts` |

Not shipped: `SandboxAttestation` and `isStrictAttestation()` exist in `packages/types/src/sandbox.ts`, but no config-load validator reads them and no runtime warning names an unsandboxed shell. The only caller of `isStrictAttestation` is the backend conformance suite.

- Posture tests: `packages/wiring/src/__tests__/resolve-execution-posture.test.ts`
- See also: [G-EXEC](.././security-boundary.md#g-exec) in the security boundary

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.
