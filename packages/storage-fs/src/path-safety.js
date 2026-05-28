import { resolve } from 'node:path';
/**
 * Resolve an untrusted path segment relative to a scope root, ensuring
 * the result stays within the root. Throws if the resolved path escapes
 * the scope boundary.
 *
 * Rejects segments containing `..`, NUL bytes, or backslashes before
 * resolution, then re-checks the resolved result starts with the
 * normalized scope root.
 */
export function resolveScopedPath(scopeRoot, untrustedSegment) {
    // Pre-check: reject obviously dangerous patterns before resolution.
    if (untrustedSegment.includes('..')) {
        throw new Error(`Path segment contains "..": "${untrustedSegment}" — path traversal is not allowed`);
    }
    if (untrustedSegment.includes('\0')) {
        throw new Error('Path segment contains NUL byte — rejected');
    }
    if (untrustedSegment.includes('\\')) {
        throw new Error(`Path segment contains backslash: "${untrustedSegment}" — non-portable path separator`);
    }
    const normalizedRoot = resolve(scopeRoot);
    const resolved = resolve(normalizedRoot, untrustedSegment);
    // Post-check: the resolved path must start with the scope root followed
    // by a `/` (or be the root itself). Without the slash check, a scope root
    // of `/a/b` would incorrectly allow `/a/bc/...`.
    if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
        throw new Error(`Resolved path "${resolved}" escapes scope root "${normalizedRoot}" — access denied`);
    }
    return resolved;
}
/**
 * Validate that a string is safe to use as a single path segment (file or
 * directory name). Intended for Zod schema boundaries: personality names,
 * team names, skill slugs, etc.
 *
 * Rejects if the segment:
 * - Is empty
 * - Contains `..`
 * - Contains `/` or `\\`
 * - Contains NUL (`\0`)
 * - Starts with `.` (hidden files)
 */
export function isSafePathSegment(segment) {
    if (segment.length === 0)
        return false;
    if (segment.includes('..'))
        return false;
    if (segment.includes('/'))
        return false;
    if (segment.includes('\\'))
        return false;
    if (segment.includes('\0'))
        return false;
    if (segment.startsWith('.'))
        return false;
    return true;
}
