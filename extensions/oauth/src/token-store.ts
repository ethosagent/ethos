import type { CredentialRef, TokenSet } from '@ethosagent/oauth-core';
import type { Storage } from '@ethosagent/types';

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`Unsafe ${label}: "${value}" — only [a-zA-Z0-9_-] allowed`);
  }
}

export interface CredentialMeta {
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  clientSecret?: string;
  clientAuth?: string;
}

export class OAuthTokenStore {
  constructor(
    private readonly storage: Storage,
    private readonly basePath: string,
  ) {}

  async get(ref: CredentialRef): Promise<TokenSet | null> {
    const path = this.tokenPath(ref);
    const raw = await this.storage.read(path);
    if (raw === null) return null;
    return JSON.parse(raw) as TokenSet;
  }

  async set(ref: CredentialRef, tokens: TokenSet): Promise<void> {
    const path = this.tokenPath(ref);
    const dir = path.slice(0, path.lastIndexOf('/'));
    await this.storage.mkdir(dir);
    await this.storage.writeAtomic(path, JSON.stringify(tokens), { mode: 0o600 });
  }

  async delete(ref: CredentialRef): Promise<void> {
    const path = this.tokenPath(ref);
    const exists = await this.storage.exists(path);
    if (exists) {
      await this.storage.remove(path);
    }
  }

  async getMeta(ref: CredentialRef): Promise<CredentialMeta | null> {
    const path = this.metaPath(ref);
    const raw = await this.storage.read(path);
    if (raw === null) return null;
    return JSON.parse(raw) as CredentialMeta;
  }

  async setMeta(ref: CredentialRef, meta: CredentialMeta): Promise<void> {
    const path = this.metaPath(ref);
    const dir = path.slice(0, path.lastIndexOf('/'));
    await this.storage.mkdir(dir);
    await this.storage.writeAtomic(path, JSON.stringify(meta), { mode: 0o600 });
  }

  async deleteMeta(ref: CredentialRef): Promise<void> {
    const path = this.metaPath(ref);
    const exists = await this.storage.exists(path);
    if (exists) {
      await this.storage.remove(path);
    }
  }

  async status(
    ref: CredentialRef,
  ): Promise<{ present: boolean; expiresAt?: string; scopes?: string[] }> {
    const tokens = await this.get(ref);
    if (!tokens) return { present: false };
    return {
      present: true,
      expiresAt: tokens.expires_at,
      scopes: tokens.scopes,
    };
  }

  private tokenPath(ref: CredentialRef): string {
    assertSafeSegment(ref.personalityId, 'personalityId');
    assertSafeSegment(ref.providerId, 'providerId');
    const profile = ref.profile ?? 'default';
    assertSafeSegment(profile, 'profile');
    return `${this.basePath}/${ref.personalityId}/oauth/${ref.providerId}/${profile}.json`;
  }

  private metaPath(ref: CredentialRef): string {
    assertSafeSegment(ref.personalityId, 'personalityId');
    assertSafeSegment(ref.providerId, 'providerId');
    const profile = ref.profile ?? 'default';
    assertSafeSegment(profile, 'profile');
    return `${this.basePath}/${ref.personalityId}/oauth/${ref.providerId}/${profile}.meta.json`;
  }
}
