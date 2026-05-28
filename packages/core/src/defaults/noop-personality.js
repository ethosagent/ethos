const DEFAULT_PERSONALITY = {
  id: 'default',
  name: 'Default',
  description: 'Default Ethos personality',
};
export class DefaultPersonalityRegistry {
  personalities = new Map([['default', DEFAULT_PERSONALITY]]);
  defaultId = 'default';
  define(config) {
    this.personalities.set(config.id, config);
  }
  get(id) {
    return this.personalities.get(id);
  }
  list() {
    return [...this.personalities.values()];
  }
  getDefault() {
    return this.personalities.get(this.defaultId) ?? DEFAULT_PERSONALITY;
  }
  setDefault(id) {
    if (!this.personalities.has(id)) {
      throw new Error(`Unknown personality: ${id}`);
    }
    this.defaultId = id;
  }
  async loadFromDirectory(_dir) {
    // Implemented in extensions/personalities
  }
  remove(id) {
    this.personalities.delete(id);
  }
}
