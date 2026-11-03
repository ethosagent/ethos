# @ethosagent/personality-judge

## Purpose

Scores how well recent agent responses stay true to a personality's Core and Expression, using an LLM judge run through the eval harness. It gates on a minimum number of interactions and elapsed hours, and turns a sustained run of low scores into a `drift` or `underspecified_soul` signal. It does not run the agent or store results; the caller supplies an `AlignmentRunner`.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `scorePersonality` | function | Scores a window of recent prompts and returns `insufficient_data` or a scored result with the new low streak. |
| `interpretSignal` | function | Maps score and streak to `drift`, `underspecified_soul` or `null`. |
| `buildAlignmentRubric` | function | Builds the judge rubric from Core and Expression. |
| `ScoreParams` | type | Inputs to `scorePersonality`. |
| `ScoreOutcome` | type | `insufficient_data` or `scored`. |
| `JudgeResult` | type | Score, per-dimension evidence and signal for one window. |
| `JudgeActivation` | type | `minInteractions` and `minElapsedHours`. |
| `AlignmentRunner` | type | Structural runner so tests can stub the harness. |
| `DEFAULT_ACTIVATION` | const | 20 interactions, 12 hours. |
| `GOOD_ALIGNMENT_THRESHOLD` | const | 0.85, at or above is well aligned. |
| `LOW_ALIGNMENT_THRESHOLD` | const | 0.5, below counts toward a streak. |
| `SUSTAINED_LOW_BATCHES` | const | 3 consecutive low batches before a signal fires. |

## Seam

Layer `extensions`. No `@ethosagent/types` contract is implemented; it consumes `BatchTask` from `@ethosagent/batch-runner` and `EvalExpected` and `EvalStats` from `@ethosagent/eval-harness` as types, and declares `AlignmentRunner` structurally so no `AgentLoop` is imported.

## Testing

```
pnpm vitest run extensions/personality-judge
```

`src/__tests__/personality-judge.test.ts` holds: the rubric embeds Core and Expression, `insufficient_data` below the interaction or hour gate, default and overridden activation, no signal below the streak threshold, `drift` on sustained low with a rich soul, `underspecified_soul` on a short Core or empty Expression, and the streak reset on a non-low score.
