---
name: spike
description: Throwaway exploration to validate an idea before committing to a real implementation. Time-boxed; isolated under ~/.ethos/spikes/ so it never pollutes the project. Use when the question is "is this even feasible?".
version: 1.0.0
author: ethosagent
tags: [coding, planning, prototyping]
required_tools: [read_file, write_file, terminal]

ethos:
  category: planning-and-process
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [process]
  integrates_with:
    - tool: process
      role: long-running spikes (e.g. a server or watcher) run as a background process so they can be killed cleanly
  surface_metadata:
    invocation_trigger: "user says 'let's just see if X works' / 'quick experiment' / 'prototype'; agent self-invokes when the question is feasibility"
    estimated_turns: "3-10 (small, by design)"
---

# Spike

Throwaway exploration. The output is "yes / no / maybe with these caveats", not production code.

## When to use this skill

- The question is "is this even feasible?" — you do not yet know whether the right approach exists.
- The user said "prototype this", "just see if X works", "quick experiment".
- A spike is cheaper than reading docs (e.g. you'd rather find out how a library actually behaves than guess from its README).

When the answer is already known, write real code. Do not spike.

## What this skill writes

Spikes live under `~/.ethos/spikes/<personality>/<slug>/`. They never go inside the project working directory. This is deliberate — spikes are throwaway, and putting them in the project would invite "but it works in the spike" arguments.

Spikes auto-expire after 14 days unless explicitly kept (see "Outcome" below).

## The procedure

1. **Acknowledge that this is throwaway.** The first line of any spike file is `# Spike: <question>`. Set the user's expectation that nothing here is going to ship as-is.

2. **Pick the smallest scope that answers the feasibility question.** A spike is not a feature. If you find yourself adding a second concern, stop — that's a sign the spike has scope-crept and the answer is already "yes, but with these constraints".

3. **Set up the spike directory:**
   ```
   ~/.ethos/spikes/<personality>/<slug>/
   ├── README.md          # the question, the approach, the result
   └── <code, scripts, fixtures>
   ```

4. **Run / measure / report.** Whatever the question demanded — execute it, capture the output, write the result into `README.md`.

5. **Outcome.** End with a one-line recommendation:
   - **Keep** — leave it where it is, may revisit
   - **Promote** — move it to the project (the user runs `ethos spike promote <slug>` to do this; do not move it yourself)
   - **Discard** — delete it now

## Hard rules

- Spikes never touch the project working directory. If you want to spike with the project's code, copy the relevant files into the spike directory first.
- A spike that grows past ~200 lines is no longer a spike — it has become a proto-implementation. Stop, write a plan, then start over.
- Output a recommendation. A spike with no recommendation is not a finished spike.

## Integrates with

- The `process` tool, when the spike needs to run a long-lived process (a server, a watcher). Start it with `process_start`, leave it running, kill with `process_stop` when done. Do not block the chat on a long-running spike.
