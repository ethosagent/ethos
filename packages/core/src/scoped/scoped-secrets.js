export class ScopedSecretsImpl {
    declaredRefs;
    backend;
    constructor(declaredRefs, backend) {
        this.declaredRefs = declaredRefs;
        this.backend = backend;
    }
    async get(ref) {
        if (!this.declaredRefs.has(ref)) {
            throw new Error(`SECRET_NOT_DECLARED: ${ref} is not in the tool's declared secrets`);
        }
        return this.backend(ref);
    }
}
