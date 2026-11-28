import { assertSafeId, type WorldId } from '@ethosagent/types';

const SHARED_PREFIX = 'world:';
const PRIVATE_PREFIX = 'personality:';

/** True when `s` passes `assertSafeId` (lowercase slug, no separators or dots). */
export function isSafeSlug(s: string): boolean {
  try {
    assertSafeId(s, 'world slug');
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `world:<slug>` or `personality:<pid>`. Throws on anything else; the
 * slug half goes through `assertSafeId` (`packages/types/src/id-validation.ts`),
 * pinned by world-access.test.ts 'parseWorldId rejects unsafe ids'.
 */
export function parseWorldId(s: string): WorldId {
  if (s.startsWith(SHARED_PREFIX)) {
    const slug = s.slice(SHARED_PREFIX.length);
    assertSafeId(slug, 'world id');
    return `world:${slug}`;
  }
  if (s.startsWith(PRIVATE_PREFIX)) {
    const pid = s.slice(PRIVATE_PREFIX.length);
    assertSafeId(pid, 'world id');
    return `personality:${pid}`;
  }
  throw new Error(`invalid world id "${s}": expected world:<slug> or personality:<pid>`);
}

export function sharedWorldId(slug: string): WorldId {
  assertSafeId(slug, 'world slug');
  return `world:${slug}`;
}

export function privateWorldId(personalityId: string): WorldId {
  assertSafeId(personalityId, 'personality id');
  return `personality:${personalityId}`;
}

/** `world:acme` -> `acme`; `personality:eng` -> `eng`. */
export function worldSlug(id: WorldId): string {
  return id.slice(id.indexOf(':') + 1);
}
