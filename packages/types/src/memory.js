// Memory subsystem — five-method MemoryProvider contract.
//
// A memory provider is keyed by `key` strings within an opaque `scopeId`.
// The scope is intentionally opaque so providers don't depend on Ethos
// concepts like personalities; callers stamp the scope ("personality:<id>"
// or "team:<id>") and the provider routes storage accordingly.
//
// The contract is FROZEN at five methods. Adding a sixth requires the
// memory-method-count gate in __tests__/memory-method-count.test.ts to be
// bumped in the same commit (mirrors PersonalityConfig's field-count
// gate). The number is a load-bearing schema discipline, not a spec.
export {};
