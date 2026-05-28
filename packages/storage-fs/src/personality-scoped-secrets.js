export class PersonalityScopedSecrets {
    inner;
    personalityId;
    constructor(inner, personalityId) {
        this.inner = inner;
        this.personalityId = personalityId;
    }
    scope(ref) {
        return `personalities/${this.personalityId}/${ref}`;
    }
    get(ref) {
        return this.inner.get(this.scope(ref));
    }
    set(ref, value) {
        return this.inner.set(this.scope(ref), value);
    }
    delete(ref) {
        return this.inner.delete(this.scope(ref));
    }
    async list(prefix) {
        const scopedPrefix = this.scope(prefix ?? '');
        const all = await this.inner.list(scopedPrefix);
        const base = `personalities/${this.personalityId}/`;
        return all.map((r) => r.slice(base.length));
    }
}
