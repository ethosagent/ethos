// @ethosagent/types — Storage interface
//
// Abstraction over filesystem operations under ~/.ethos/. Every consumer
// that reads or writes Ethos state takes a Storage in its constructor.
// Production wires FsStorage; tests wire InMemoryStorage; ScopedStorage
// decorates either with a per-personality path-allowlist.
//
// Path semantics: all paths are absolute. The interface does NOT manage a
// root — consumers compute absolute paths via ethosDir() (or analog) and
// pass them in. ScopedStorage enforces an allowlist by validating each
// absolute path against a configured set of allowed prefixes.
//
// Error semantics:
//   - read/exists/mtime return null when the target doesn't exist
//   - All other operations throw on failure
//   - ScopedStorage throws BoundaryError when a path is outside the allowlist
/**
 * Thrown by ScopedStorage when a read or write targets a path outside the
 * configured allowlist. Consumers (e.g. tools-file) should translate this
 * into a user-facing tool error rather than letting it propagate.
 */
export class BoundaryError extends Error {
    code = 'storage-boundary';
    kind;
    path;
    constructor(kind, path, allowed, why) {
        const suffix = why ? ` (${why})` : '';
        super(`${kind} not permitted: ${path} not in [${allowed.join(', ')}]${suffix}`);
        this.name = 'BoundaryError';
        this.kind = kind;
        this.path = path;
    }
}
