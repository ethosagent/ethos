import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export class IdentityMap {
  opts;
  entries = null;
  mapPath;
  constructor(opts) {
    this.opts = opts;
    this.mapPath = join(opts.dataDir, 'users', 'identity-map.json');
  }
  async resolve(platform, platformUserId, displayLabel) {
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
  async listUsers() {
    return await this.load();
  }
  async load() {
    if (this.entries) return this.entries;
    const raw = await this.opts.storage.read(this.mapPath);
    const parsed = raw ? JSON.parse(raw) : [];
    this.entries = parsed;
    return parsed;
  }
  async save(entries) {
    this.entries = entries;
    await this.opts.storage.mkdir(join(this.opts.dataDir, 'users'));
    await this.opts.storage.writeAtomic(this.mapPath, JSON.stringify(entries, null, 2));
  }
}
