import { DefaultOAuthRegistry, DefaultOAuthService, OAuthTokenStore } from '@ethosagent/oauth';
import { createCryptoStorage } from '@ethosagent/storage-crypto';
import type { Storage } from '@ethosagent/types';

/**
 * Create a production OAuthService + OAuthRegistry pair.
 *
 * When `passphrase` is provided, token storage is encrypted-at-rest via
 * CryptoStorage (same pattern as compose-tools.ts). When absent, tokens
 * are stored in plaintext (dev/test backward compat).
 *
 * NOTE: enabling encryption on an existing installation will invalidate
 * previously-stored plaintext tokens. Users must re-authorize.
 */
export function createOAuthService(opts: { storage: Storage; passphrase?: string }): {
  service: DefaultOAuthService;
  registry: DefaultOAuthRegistry;
} {
  const tokenStorage = opts.passphrase
    ? createCryptoStorage(opts.storage, opts.passphrase)
    : opts.storage;
  const tokenStore = new OAuthTokenStore(tokenStorage, 'oauth');
  const registry = new DefaultOAuthRegistry();
  const service = new DefaultOAuthService(tokenStore, registry);
  return { service, registry };
}
