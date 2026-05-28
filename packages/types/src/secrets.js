export class SecretNotFoundError extends Error {
    ref;
    code = 'SECRET_NOT_FOUND';
    constructor(ref) {
        super(`Secret not found: ${ref}`);
        this.ref = ref;
    }
}
