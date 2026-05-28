// Logger contract for library output.
//
// Library code (everything outside designated app entry points) emits all
// human-readable output through this interface — never directly to stdout
// or stderr. Apps install a concrete Logger at composition time; when
// none is installed, the framework substitutes a no-op so libraries stay
// silent.
//
// Implementations ship in @ethosagent/logger (NoopLogger, ConsoleLogger).
// See ARCHITECTURE.md §III Law 10.
export {};
