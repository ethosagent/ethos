# @ethosagent/<name>

## Purpose

One to three sentences: what this package does and for whom, stated as a concrete fact rather than
a slogan. Name what it owns and what it deliberately leaves to its neighbours. A reader who never
opens the docs site should know whether this is the package they need.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `createThing` | function | Builds a `Thing` from a validated config. |
| `ThingOptions` | type | Options accepted by `createThing`. |

List what `package.json` `exports` exposes, nothing internal.

## Seam

Contract this package implements or protects: an `@ethosagent/types` interface (for example
`Storage`) or an ARCHITECTURE.md section or Law (for example Law 2). Name the archcheck layer from
`architecture.config.ts` (`contracts`, `core`, `wiring`, `security-kernel`, `extensions`,
`app-entry`). Cite the file or test that enforces each guarantee you claim.

## Testing

```
pnpm vitest run <dir>
```

Pinning tests: list the test files that fail if the seam breaks, with the guarantee each one holds.
