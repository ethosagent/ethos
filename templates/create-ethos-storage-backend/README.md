# create-ethos-storage-backend

Starter template for an Ethos storage backend plugin.

## Usage

1. Copy this template directory
2. Replace `BACKEND_NAME` in package.json with your backend name
3. Implement the `Storage` interface in `src/index.ts`
4. Register via `api.registerStorage('name', factory)` in activate()

The framework always wraps your backend in `ScopedStorage` at the personality boundary. Your implementation provides raw persistence; the framework handles access control.

## Key contract

- `read`/`exists`/`mtime` return `null` for missing paths
- `writeAtomic` must be all-or-nothing
- `chmod` may be a no-op for non-POSIX backends
- Credentials come from `SecretsResolver`, never from config values
