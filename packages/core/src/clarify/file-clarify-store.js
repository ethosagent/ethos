// File-backed ClarifyStore — pending clarify requests persisted to a single
// atomic-write JSON file so async surfaces and browser refreshes survive a
// process restart. See plan/phases/tool_clarity_plan.md.
//
// The store owns only `pending.json`. A per-process mutex serializes the
// read-modify-write cycle; `writeAtomic` keeps the file consistent even under
// a cross-process race (the gateway daemon and web-api both write).
export class FileClarifyStore {
  storage;
  root;
  pendingPath;
  /** Serializes the read-modify-write cycle within this process. */
  mutex = Promise.resolve();
  /** `root` is the absolute `~/.ethos/clarify` directory (caller-resolved). */
  constructor(storage, root) {
    this.storage = storage;
    this.root = root;
    this.pendingPath = `${root}/pending.json`;
  }
  async add(req) {
    await this.mutate((rows) => {
      const without = rows.filter((r) => r.requestId !== req.requestId);
      without.push(req);
      return without;
    });
  }
  async get(requestId) {
    const rows = await this.readAll();
    return rows.find((r) => r.requestId === requestId) ?? null;
  }
  async list(filter) {
    const rows = await this.readAll();
    return rows.filter(
      (r) =>
        (filter?.surfaceType === undefined || r.surfaceType === filter.surfaceType) &&
        (filter?.sessionId === undefined || r.sessionId === filter.sessionId),
    );
  }
  async remove(requestId) {
    await this.mutate((rows) => rows.filter((r) => r.requestId !== requestId));
  }
  async update(requestId, patch) {
    await this.mutate((rows) => {
      const idx = rows.findIndex((r) => r.requestId === requestId);
      if (idx < 0) return rows;
      const target = rows[idx];
      if (!target) return rows;
      // Splice in a single replacement; `requestId` is immutable on update.
      const next = [...rows];
      next[idx] = { ...target, ...patch, requestId: target.requestId };
      return next;
    });
  }
  async expired(now) {
    const rows = await this.readAll();
    const cutoff = now.getTime();
    return rows.filter((r) => new Date(r.defaultDeadlineAt).getTime() <= cutoff);
  }
  // ---------------------------------------------------------------------------
  async readAll() {
    const raw = await this.storage.read(this.pendingPath);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // A corrupt pending file should not wedge the agent — start fresh.
      return [];
    }
  }
  /** Run a read-modify-write under the per-process mutex with an atomic write. */
  async mutate(fn) {
    const run = this.mutex.then(async () => {
      const rows = await this.readAll();
      const next = fn(rows);
      await this.storage.mkdir(this.root);
      await this.storage.writeAtomic(this.pendingPath, `${JSON.stringify(next, null, 2)}\n`);
    });
    // Keep the chain alive even if this op throws, so later ops still serialize.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
