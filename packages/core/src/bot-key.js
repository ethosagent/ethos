import { createHash } from 'node:crypto';
/**
 * Derive a stable `botKey` from an opaque seed string.
 *
 * Returns the first 24 hex chars of sha256(seed) — 96 bits, wide enough
 * that birthday collisions are cosmologically unlikely. The value is used
 * as a routing/lane key and as a duplicate-detection key in bot binding
 * validation.
 *
 * Every adapter and config layer that needs a stable bot identity must
 * call this function rather than rolling its own hash. Two sources of
 * truth for the algorithm means two sources of divergence.
 */
export function deriveBotKey(seed) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 24);
}
