# @ethosagent/digest

## Purpose

Generator for the weekly governed-learning digest. Given personalities, a `Storage`, a data directory and a clock, it reads each personality's learning sidecars and returns one Markdown report. CLI orchestration (registry loading, file write, email) lives in `apps/ethos/src/commands/digest.ts`, and web-api's `DigestService.generate` drives the same generator.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `buildWeeklyDigest` | function | Renders the Markdown digest from a `WeeklyDigestInput`. |
| `WeeklyDigestInput` | interface | Personalities, storage, `dataDir`, `now`, optional `windowDays` (default 7) and per-personality learning log and skill candidates. |
| `waitingSkillNamesByPersonality` | function | Groups learning-inbox skill candidates into filenames per personality. |
| `isoWeek` | function | ISO 8601 `{ year, week }` for a date. |
| `isoWeekLabel` | function | The week label used in the report. |

## Seam

Consumes the `Storage`, `PersonalityConfig` and `LearningLogEntry` contracts from `@ethosagent/types`; it implements no interface. Callers read the learning inbox and log and pass them in, so the package does no registry or inbox access of its own. Archcheck layer: `extensions`. Limitation: the header comment says it never touches `node:fs` or the network, but no test pins that.

## Testing

```
pnpm vitest run extensions/digest
```

Pinning tests: `src/__tests__/digest.test.ts` holds the ISO week label, activity sections for a personality with recent learning and judge data, inbox candidate counts (not the retired `.pending` directory), the "No activity" case, window exclusion, a second write of the same week overwriting one file, and a malformed judge sidecar treated as empty.
