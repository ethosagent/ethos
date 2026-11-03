---
title: "config.yaml: learning and evolver keys"
description: "config.yaml learning replay, nightly pass and evolver keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that schedule learning and evolution jobs. Part of the [config.yaml reference](../config-yaml.md).

## learningReplay.* {#learning-replay}

Type: object · Default: every field at its default below · Required: no

Settings for the replay that measures a learned skill or Expression change against frozen past tasks before it can go live. Absent keys take `LEARNING_REPLAY_DEFAULTS`, applied by `resolveLearningReplay` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts). Every number is validated as the whole string, so a value with trailing text (`8 cases`, `0.5usd`) is a parse error, not the leading number.

| Field | Type | Default | Description |
|---|---|---|---|
| `learningReplay.enabled` | boolean | `true` | `false` stops replay running at all: the nightly pass skips its `replay` step and `ethos learning replay <id>` refuses with `replay_unavailable`. It does not let anything go live unmeasured. A candidate with no verdict is never auto-promoted, so every candidate waits for a human, who must give a reason to approve it. Any value other than the literal `true` reads as `false`. |
| `learningReplay.maxCases` | integer ≥ 3 | `8` | Cases replayed per candidate, at most 3 of them target cases. A value below 3 is a parse error: a replay of fewer than 3 cases can never reach a `pass` verdict. Values above 8 are clamped to 8 (`MAX_REPLAY_CASES`, `extensions/learning-inbox/src/replay.ts`). |
| `learningReplay.maxCostUsd` | number > 0 | `0.50` | Replay-loop spend per candidate, in USD. A run that crosses it stops and scores `incomplete`, so the candidate cannot auto-promote. Written as digits with an optional decimal part (`0.5`, `2`). Grader calls are not counted against it. |
| `learningReplay.maxCandidatesPerRun` | integer ≥ 1 | `5` | Candidates one nightly run replays, across all personalities together, oldest first. The rest wait for the next run. |

```yaml
learningReplay.enabled: true
learningReplay.maxCases: 8
learningReplay.maxCostUsd: 0.50
learningReplay.maxCandidatesPerRun: 5
```

Notes:

- Replay measures approach, not answers. Tools are stubbed in a dry run, so a replay scores tool choice, arguments, voice and approach, but not whether an answer that depends on real tool output got better. A `pass` is not proof the change improved answers.
- Replay runs real models and costs money on every candidate it measures, for both the baseline arm and the candidate arm.
- See [Why does a learned change need a replay before it goes live?](../../explanation/learning-inbox.md) for the verdict rules and when a `pass` promotes on its own.

## nightlyPass.* {#nightly-pass}

Type: object · Default: off · Required: no

The scheduled nightly learning pass. When enabled, a serving process (`ethos serve`, `ethos gateway start`, `ethos boot`) creates a `nightly-pass` cron job (`systemJobSpecs`, [`packages/wiring/src/system-jobs.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/system-jobs.ts)). The pass freezes new replay cases, drafts skill and Expression candidates, and replays `pending_replay` candidates. `ethos nightly run [<id>]` runs the same pass once, on demand, whatever this key says.

| Field | Type | Default | Description |
|---|---|---|---|
| `nightlyPass.enabled` | boolean | `false` | Schedule the pass. Any value other than the literal `true` reads as `false`. |
| `nightlyPass.cron` | cron expression | `0 3 * * *` | When the pass fires. Only meaningful when `enabled` is `true`. |

```yaml
nightlyPass.enabled: true
nightlyPass.cron: 0 3 * * *
```

Notes:

- **Off by default means candidates are not replayed on a schedule.** A draft from the post-turn fork, `skill_propose`, `ethos evolve` or `ethos personality evolve` sits in `pending_replay` until `ethos learning replay <id>` or `ethos nightly run` measures it, or a human approves it with a reason. `autoApprove` and `skill_evolution.promotion: auto` do not skip this wait: nothing promotes itself without a `pass` replay.
- **With it off, no new cases are frozen on a schedule.** The pass freezes up to 10 cases per personality per run. Without regression cases in the pool, a replay scores `incomplete` for too few cases, and the candidate waits for a human.
- The schedule only fires while a serving process runs. `ethos chat` alone runs no cron.
- How many candidates one run replays, and what each may spend, are [`learningReplay.*`](#learning-replay) settings.

## evolver.cron_enabled {#evolver-cron-enabled}

Type: boolean · Default: `false`

When `true`, a serving process (`ethos serve`, `ethos gateway start`, `ethos boot`) creates a `skill-evolver` cron job that runs `ethos evolve run --quiet` on the schedule defined by [`evolver.schedule`](#evolver-schedule) (`systemJobSpecs`, [`packages/wiring/src/system-jobs.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/system-jobs.ts)). `false` removes the job the next time a serving process starts.

```yaml
evolver.cron_enabled: true
```

## evolver.schedule {#evolver-schedule}

Type: string (5-field cron expression) · Default: `"0 3 * * *"`

Controls when the evolve cron fires. Only meaningful when [`evolver.cron_enabled`](#evolver-cron-enabled) is `true`.

```yaml
evolver.schedule: 0 3 * * *
```

Notes:

- The schedule only fires while a serving process runs. `ethos chat` alone runs no cron.
- Each run drafts for the default `personality` in this file, and submits every draft to the learning inbox as a candidate. None goes live without a `pass` replay or a human approval; see [Why does a learned change need a replay before it goes live?](../../explanation/learning-inbox.md).
- Per-personality skill evolution keys (`skill_evolution.enabled`, `promotion`, `scope` and the rest) live in the [personality config.yaml](../personality-yaml.md#skill-evolution), not here. The evolver cron does not read `skill_evolution.enabled`: that key gates the post-turn fork and the nightly skill drafter.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
