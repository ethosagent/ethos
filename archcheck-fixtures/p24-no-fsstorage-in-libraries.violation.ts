// archcheck-fixture: place-at extensions/archcheck-fixture/src/constructs-storage.ts
//
// An extension constructing FsStorage itself instead of receiving the Storage from wiring. The
// rule is syntactic (`new FsStorage`), so a local declaration stands in for the real export from
// @ethosagent/storage-fs — the scratch tree has no workspace packages to resolve it against.
declare class FsStorage {}

export const storage = new FsStorage();
