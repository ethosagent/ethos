---
title: "Qualify a local model"
description: "Score an Ollama or vLLM model against the evals/local suite and read the per-category pass rates, repair rate, and hard invariants."
kind: how-to
audience: user
slug: qualify-a-local-model
time: "10 min"
updated: 2026-07-13
---

## Task

Run the committed `evals/local` suite against a local model and decide whether it is reliable enough for real work.

## Result

`ethos eval local --model <id>` prints pass rates per category, the tool-call repair rate, and the two hard invariants — enough signal to trust a model with a workload or reject it.

## Prereqs

- `ethos` on `PATH` (Node 24+). Run `ethos --version` to confirm.
- A configured provider that can reach the model — a local [Ollama or vLLM endpoint](configure-providers), or any OpenAI-compatible server.
- The repo checkout (the suite lives at `evals/local/` in the source tree).

## What the suite checks

The dataset is a starter set — a handful of cases per category, tagged by an `<category>/<name>` id prefix. It grows over time.

| Category | What it probes |
|---|---|
| `tool-calling` | The model calls the right tool with usable args. Includes a nested-args case that tends to elicit malformed JSON, exercising the repair path. |
| `json-discipline` | The model returns exactly the requested JSON — no prose, no code fences. |
| `planning` | The model decomposes a task into a coherent multi-step plan. |
| `coding` | The model produces a correct small code edit. |
| `compaction-survival` | A needle-in-a-long-note case: the answer must survive context compaction on a small-window model. |

## Steps

### 1. Run the suite

```bash
ethos eval local --model llama3.2
```

Omit `--model` to score the model already configured in `~/.ethos/config.yaml`. Point at a different dataset directory with `--dataset <dir>` (default `evals/local`).

### 2. Read the per-category rates

```
Pass rates by category
  coding                 100% (2/2)
  compaction-survival    100% (1/1)
  json-discipline         50% (1/2)
  planning               100% (2/2)
  tool-calling            67% (2/3)

Overall  8 passed  2 failed  avg 80%
```

A low rate in one category is a targeted signal — `json-discipline` misses usually mean the model wraps JSON in prose or fences; `tool-calling` misses mean the model picked the wrong tool or fumbled its arguments.

### 3. Read the repair rate and invariants

```
Tool-call repair (this run's tool.repair events)
  repaired 1  ·  failed 0  ·  repair success 100%

Hard invariants
  execute-with-{} occurrences: 0  (must be 0 — unparseable args become is_error, never a silent {})
  tool-calling parse-clean rate: 67%  (target ≥ 90%; observed via final-answer correctness)
```

- **Repair rate** comes from the `tool.repair` observability events emitted this run. `repaired` args were mechanically recovered; `failed` args could not be — they became an `is_error` tool_result the model can see and retry, never a silent empty-args call.
- **`execute-with-{}` occurrences must be 0.** This is an invariant, not a bar — a malformed tool call is never executed with `{}`. A non-zero value means a regression.
- **`tool-calling` parse-clean rate targets ≥ 90%.** The eval harness records the model's text, not per-call parses, so this rate is observed through final-answer correctness rather than a direct per-call count.

## Verify

- The command exits after printing all three sections. The scored transcript is written to `~/.ethos/eval-local.eval.jsonl` — inspect it to see each case's raw answer and score.
- Re-run with `--concurrency 1` for a deterministic, serialized pass if a category rate looks noisy.

## Troubleshoot

- **`Cannot load dataset from evals/local`** — run the command from the repo root, or pass an absolute `--dataset` path.
- **Repair rate shows `unavailable`** — the observability store at `~/.ethos/observability.db` could not be opened; the pass rates are still valid.
- **Every category at 0%** — the provider is unreachable or the model id is wrong. Confirm with `ethos doctor` and a plain `ethos chat` turn first.
