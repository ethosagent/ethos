# evals/local

Committed datasets for local qualification and context-economy tracking.

- `tasks.jsonl` / `expected.jsonl` — the `ethos eval local` suite (scored with the `contains` scorer by default).
- `context-baseline.json` — Phase-0 context-economy baseline written by `ethos bench context --write-baseline`: per-personality static token tax (SOUL.md + tool schemas), plus live per-turn scenario results when run with `--live`.
