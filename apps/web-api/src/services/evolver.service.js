export class EvolverService {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async getConfig() {
    return { config: await this.opts.evolver.getConfig() };
  }
  async updateConfig(config) {
    return { config: await this.opts.evolver.setConfig(config) };
  }
  async listPending() {
    const pending = await this.opts.library.listPending();
    return { pending: pending.map(toWirePending) };
  }
  async approvePending(id) {
    await this.opts.library.approvePending(id);
  }
  async rejectPending(id) {
    await this.opts.library.rejectPending(id);
  }
  async listHistory(limit = 20) {
    return { runs: await this.opts.evolver.listHistory(limit) };
  }
}
function toWirePending(record) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    proposedAt: record.proposedAt,
  };
}
