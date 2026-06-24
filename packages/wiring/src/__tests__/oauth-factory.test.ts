import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { createOAuthService } from '../oauth-factory';

describe('createOAuthService', () => {
  it('creates service with plaintext storage when no passphrase', () => {
    const storage = new InMemoryStorage();
    const { service, registry } = createOAuthService({
      storage,
    });
    expect(service).toBeDefined();
    expect(registry).toBeDefined();
  });

  it('creates service with encrypted storage when passphrase provided', () => {
    const storage = new InMemoryStorage();
    const { service, registry } = createOAuthService({
      storage,
      passphrase: 'test-key',
    });
    expect(service).toBeDefined();
    expect(registry).toBeDefined();
  });
});
