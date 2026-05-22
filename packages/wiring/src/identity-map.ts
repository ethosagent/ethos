import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';

export interface IdentityMapEntry {
  platform: string;
  platformUserId: string;
  userId: string;
  displayLabel: string;
  firstSeenAt: string;
}

export interface IdentityMapOptions {
  storage: Storage;
  dataDir: string; // ~/.ethos
}

export class IdentityMap {
  private entries: IdentityMapEntry[] | null = null;
  private readonly mapPath: string;

  constructor(private readonly opts: IdentityMapOptions) {
    this.mapPath = join(opts.dataDir, 'users', 'identity-map.json');
  }

  async resolve(platform: string, platformUserId: string, displayLabel?: string): Promise<string> {
    const entries = await this.load();
    const existing = entries.find(
      (e) => e.platform === platform && e.platformUserId === platformUserId,
    );
    if (existing) return existing.userId;

    // Mint new short opaque id
    const userId = randomUUID().replace(/-/g, '').slice(0, 12);
    entries.push({
      platform,
      platformUserId,
      userId,
      displayLabel: displayLabel ?? `${platform}:${platformUserId}`,
      firstSeenAt: new Date().toISOString(),
    });
    await this.save(entries);
    return userId;
  }

  async listUsers(): Promise<IdentityMapEntry[]> {
    return await this.load();
  }

  private async load(): Promise<IdentityMapEntry[]> {
    if (this.entries) return this.entries;
    const raw = await this.opts.storage.read(this.mapPath);
    const parsed: IdentityMapEntry[] = raw ? JSON.parse(raw) : [];
    this.entries = parsed;
    return parsed;
  }

  private async save(entries: IdentityMapEntry[]): Promise<void> {
    this.entries = entries;
    await this.opts.storage.mkdir(join(this.opts.dataDir, 'users'));
    await this.opts.storage.writeAtomic(this.mapPath, JSON.stringify(entries, null, 2));
  }
}
