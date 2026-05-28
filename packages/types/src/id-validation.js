// Path-traversal prevention: ID validation for user-supplied identifiers.
//
// User-supplied identifiers (personalityId, skillId, etc.) are used in
// path.join() calls. Without charset validation, a malicious ID like
// `../../../etc/passwd` escapes the intended directory. This module
// provides a single assertSafeId() guard to place at trust boundaries.
/**
 * Safe ID pattern: starts with a lowercase letter or digit, followed by
 * zero or more lowercase letters, digits, underscores, or hyphens.
 * Specifically excludes: path separators, dots (no `..`), uppercase,
 * spaces, and any special characters.
 */
const SAFE_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
export class IdValidationError extends Error {
    code = 'invalid-id';
    id;
    kind;
    constructor(id, kind) {
        super(`Invalid ${kind}: "${id}" — must match /^[a-z0-9][a-z0-9_-]*$/`);
        this.name = 'IdValidationError';
        this.id = id;
        this.kind = kind;
    }
}
/**
 * Validate that a user-supplied identifier is safe for use in path
 * construction. Call this before any `path.join(base, id, ...)`.
 *
 * @throws IdValidationError if the id is empty or contains unsafe characters
 */
export function assertSafeId(id, kind) {
    if (!id || !SAFE_ID_REGEX.test(id)) {
        throw new IdValidationError(id, kind);
    }
}
