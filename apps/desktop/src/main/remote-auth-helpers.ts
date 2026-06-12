// Pure helpers for remote-server auth header injection. Kept free of
// electron imports so they can be unit-tested directly.

/** Normalizes a remote server URL to its origin, or null if unparseable. */
export function remoteOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Returns headers with `Authorization: Bearer <token>` added, unless an
 * Authorization header (any casing) is already present.
 */
export function withBearerToken(
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (hasAuth) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}
