export class MemoryService {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async list(personalityId, listOpts) {
    const [memoryFile, userFile] = await Promise.all([
      this.readEntry('memory', personalityId, listOpts),
      this.readEntry('user', personalityId, listOpts),
    ]);
    return { items: [memoryFile, userFile], nextCursor: null };
  }
  async get(store, personalityId, getOpts) {
    return { file: await this.readEntry(store, personalityId, getOpts) };
  }
  async write(store, content, personalityId, writeOpts) {
    const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
    const ctx = this.buildCtx(this.scopeIdFor(store, personalityId, writeOpts?.userId));
    await this.opts.memory.sync([{ action: 'replace', key, content }], ctx);
    // Re-read to return the persisted state.
    const entry = await this.opts.memory.read(key, ctx);
    const modifiedAt = entry?.metadata?.lastUpdatedAt
      ? new Date(entry.metadata.lastUpdatedAt).toISOString()
      : null;
    return {
      file: {
        store,
        content: entry?.content ?? content,
        path: null,
        modifiedAt,
      },
    };
  }
  async listUsers() {
    const entries = (await this.opts.identityMap?.listUsers()) ?? [];
    return {
      users: entries.map((e) => ({
        userId: e.userId,
        displayLabel: e.displayLabel,
        platform: e.platform,
        firstSeenAt: e.firstSeenAt,
      })),
    };
  }
  async readEntry(store, personalityId, readOpts) {
    const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
    const ctx = this.buildCtx(this.scopeIdFor(store, personalityId, readOpts?.userId));
    const entry = await this.opts.memory.read(key, ctx);
    const modifiedAt = entry?.metadata?.lastUpdatedAt
      ? new Date(entry.metadata.lastUpdatedAt).toISOString()
      : null;
    return {
      store,
      content: entry?.content ?? '',
      path: null,
      modifiedAt,
    };
  }
  scopeIdFor(store, personalityId, userId) {
    if (store === 'user' && userId) return `user:${userId}`;
    return `personality:${personalityId}`;
  }
  buildCtx(scopeId) {
    return { scopeId, sessionId: '', sessionKey: '', platform: 'web', workingDir: '' };
  }
}
