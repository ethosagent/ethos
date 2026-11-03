# @ethosagent/memory-capture

## Purpose

Post-turn memory capture. `MemoryCaptureRunner` queues finished turns, filters out ineligible ones before any model call, extracts durable facts with an auxiliary LLM, dedups against history, and either writes them or proposes them to the approval gate. Storage of history and the approval queue belong to `memory-history` and `memory-approval`.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `MemoryCaptureRunner` | class | Owns the post-turn queue: eligibility, extraction, dedup, write or propose. |
| `MemoryCaptureRunnerOptions` | interface | Provider, history, session store, LLM, sanitizer, logger, config. |
| `ConsolidateFn` | type | Inline consolidation pass, run only when no nightly loop is configured. |
| `evaluateEligibility` | function | Free pre-LLM gate for a turn. |
| `EligibilityInput` | interface | Turn facts the gate reads. |
| `EligibilityResult` | type | `eligible` flag plus optional exclusion `reason`. |
| `extractFacts` | function | Calls the auxiliary LLM and parses facts. |
| `parseFacts` | function | Parses pipe-delimited fact lines. |
| `hashFact` | function | Stable hash of a normalized fact. |
| `normalizeFact` | function | Canonical form used for dedup. |
| `CaptureConfig` | interface | Capture limits. |
| `DEFAULT_CAPTURE_CONFIG` | const | Defaults for `CaptureConfig`. |
| `CaptureFact` | interface | One extracted fact. |
| `CaptureJob` | interface | One queued turn. |
| `CaptureNotice` | interface | Notice emitted on capture. |
| `MemoryProposal` | interface | Shape handed to the propose callback. |
| `ProposeFn` | type | Callback that parks a proposal in the gate. |
| `TombstoneChecker` | type | Callback that reports a retracted fact. |
| `GroundingConsult` | type | Callback that checks a fact against grounding. |

## Seam

A pipeline over `MemoryProvider` and `LLMProvider` from `@ethosagent/types`, and over `@ethosagent/memory-history` and `@ethosagent/core`; it implements no types interface itself. Contract rules in `.claude/rules/memory.md`. Archcheck layer: `extensions`.

Pinned by `src/__tests__/runner.test.ts` (writes stay inside the turn personality scope; dream, `:sub:` child and shared sessions are skipped without an LLM call), `src/__tests__/eligibility.test.ts` (shared session excluded first), `src/__tests__/runner-approval.test.ts` (gated capture proposes and never re-proposes a rejected fact) and `src/__tests__/lifecycle-retract.test.ts` (a retracted fact is not re-captured after a reword).

## Testing

```
pnpm vitest run extensions/memory-capture
```

Pinning tests in `src/__tests__/`: `src/__tests__/eligibility.test.ts`, `src/__tests__/extraction.test.ts` (malformed lines dropped, importance clamped, over-long facts capped), `src/__tests__/runner.test.ts`, `src/__tests__/runner-approval.test.ts`, `src/__tests__/runner-evidence.test.ts`, `src/__tests__/lifecycle-retract.test.ts`.
