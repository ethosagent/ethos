export class NoopMemoryProvider {
  async prefetch(_ctx) {
    return null;
  }
  async read(_key, _ctx) {
    return null;
  }
  async search(_query, _ctx, _opts) {
    return [];
  }
  async sync(_updates, _ctx) {
    // No-op
  }
  async list(_ctx, _opts) {
    return [];
  }
}
