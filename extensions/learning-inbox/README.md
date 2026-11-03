# @ethosagent/learning-inbox

## Purpose

The governed-learning pipeline for learned changes (skill and Expression candidates, identity amendments): file-backed candidate and case stores, a replay harness that measures a candidate against frozen cases, a verdict, promotion with rollback, and one `LearningInbox` service that every surface uses to approve, reject or roll back. Wiring injects the replay, the legacy import and the loop factory.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`). About 165 exports; main entry points.

| Export | Kind | One line |
|---|---|---|
| `LearningInbox` | class | List, get, replay, approve, reject, rollback; the one place decisions and audit rows happen. |
| `LearningInboxDeps` | interface | Storage, data dir, promote deps, optional replay and legacy import. |
| `LEARNING_AUDIT_CODES` | const | The audit codes the inbox writes. |
| `submitCandidate` | function | Writes a new `LearningCandidate`. |
| `listCandidates` | function | Lists candidates by filter. |
| `promote` | function | Writes an approved candidate live, with a prior snapshot. |
| `rollback` | function | Restores the prior snapshot. |
| `checkRollback` | function | Refuses when the live file changed since promotion. |
| `runReplay` | function | Runs cases through a baseline arm and a candidate arm. |
| `selectReplayCases` | function | Picks target and regression cases. |
| `computeVerdict` | function | Scores arm outcomes into a verdict. |
| `OverlayStorage` | class | Read-through `Storage` with one shadowed path; all writes throw. |
| `replayAndResolve` | function | Replay, then the one automatic promotion path. |
| `autoPromotionDecision` | function | Decides whether a verdict may promote without a human. |
| `captureCases` | function | Freezes replay cases from sessions, evals and kanban tasks. |
| `createAmendment` | function | Creates an identity amendment proposal. |
| `transitionAmendment` | function | Moves an amendment between states. |
| `importLegacyQueues` | function | Drains the legacy learning queues once. |
| `appendAudit` | function | Appends a learning audit entry. |

## Seam

`OverlayStorage` implements `Storage` from `@ethosagent/types` (`implements Storage` in `src/overlay-storage.ts`). The rest is a concrete service layered on `@ethosagent/types` and `@ethosagent/eval-harness`. Archcheck layer: `extensions`.

Pinned guarantees:

- `approve` on any verdict other than `pass` refuses without a non-blank override reason, and each landed decision writes exactly one audit row, a refusal none (`src/__tests__/inbox.test.ts`).
- Every mutating method of `OverlayStorage` throws `BoundaryError` and leaves the base untouched (`src/__tests__/overlay-storage.test.ts`).
- A shared-scope skill, a non-`pass` verdict and a user-mode Expression never auto-promote (`src/__tests__/auto-promotion.test.ts`).
- Replay runs with `dryRun: true`, refuses run options that are not a dry run, and stops over budget as `incomplete` (`src/__tests__/replay.test.ts`).

## Testing

```
pnpm vitest run extensions/learning-inbox
```

Pinning tests in `src/__tests__/`: `src/__tests__/inbox.test.ts`, `src/__tests__/overlay-storage.test.ts`, `src/__tests__/auto-promotion.test.ts`, `src/__tests__/replay.test.ts`, `src/__tests__/promote.test.ts` (stale base hash, scope change, rollback after a live edit), `src/__tests__/verdict.test.ts`.
