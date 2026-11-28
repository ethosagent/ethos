// The app-facing passthrough for the flat-skill version history and lock
// (plan `skill-history-and-lock.md`). Apps import wiring and contracts only
// (ARCHITECTURE.md §III Law 5), and `ethos skills history|diff|restore|lock`
// is a lazily-imported CLI subcommand that should not pay for the whole wiring
// barrel, so it gets `SkillHistory` from this small subpath, the way
// `./security-kernel` serves the kernel primitives.

export { diffSkillVersions, SkillHistory, type SkillVersion } from '@ethosagent/skills';
