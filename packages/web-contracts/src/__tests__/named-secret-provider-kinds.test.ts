import { describe, expect, it } from 'vitest';
import {
  NAMED_SECRET_PROVIDER_KINDS,
  NamedSecretKindSchema,
  NamedSecretProviderSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Pins the provider -> kind mapping so a new provider added to
// NamedSecretProviderSchema without a NAMED_SECRET_PROVIDER_KINDS entry (the
// TypeScript `Record<NamedSecretProvider, NamedSecretKind>` type already
// enforces this at compile time) is also caught here, and so `google` /
// `youtube-api-key` (plan/phases/social-search-tools.md M1) stay pinned.
// ---------------------------------------------------------------------------

describe('NAMED_SECRET_PROVIDER_KINDS', () => {
  it('covers every declared provider with a valid kind', () => {
    for (const provider of NamedSecretProviderSchema.options) {
      const kind = NAMED_SECRET_PROVIDER_KINDS[provider];
      expect(kind, `missing mapping for provider ${provider}`).toBeDefined();
      expect(NamedSecretKindSchema.options).toContain(kind);
    }
  });

  it('maps google to youtube-api-key', () => {
    expect(NAMED_SECRET_PROVIDER_KINDS.google).toBe('youtube-api-key');
  });
});
