---
title: "Recover from constitution safe mode"
description: "What safe mode is, when Ethos enters it, and how to repair a malformed constitution.yaml so your personalities load normally again."
kind: how-to
audience: user
slug: safe-mode
time: "5 min"
updated: 2026-06-16
---

## Task

Get Ethos out of safe mode by repairing a malformed `~/.ethos/constitution.yaml`.

## Result

The constitution parses cleanly, all your personalities load with their full
toolsets, and the operator ceiling (budget caps, forbidden hosts/tools,
filesystem bounds, execution posture) is enforced as written.

## Steps

Ethos enters **safe mode** at startup when `~/.ethos/constitution.yaml` exists
but cannot be parsed or validated. Safe mode is a fail-closed posture:

- Only built-in personalities load. Custom personalities are dropped.
- Surviving personalities keep only a read-only toolset (file/web/memory reads,
  no terminal, no writes).

You'll see an error on startup naming the parse or validation failure.

1. Open `~/.ethos/constitution.yaml` and find the field named in the error
   message. Common causes: a non-finite `budget.maxUsdPerSession`, a host/tool
   list that isn't an array of strings, an `observability.minimum` outside
   `none | redacted | full`, or invalid YAML syntax.

2. Correct the field. The constitution must be a YAML mapping. A few examples:

   ```yaml
   budget:
     maxUsdPerSession: 5
   forbidden:
     hosts: ["169.254.169.254"]
     tools: ["terminal"]
   observability:
     minimum: redacted
   ```

3. Restart Ethos. The constitution loads, safe mode clears, and your
   personalities are back with their declared toolsets.

To run without any constitution at all, delete `~/.ethos/constitution.yaml` —
a missing file is treated as a permissive default, not an error.

## Verify

Confirm safe mode has cleared:

1. Restart Ethos. The startup log no longer shows the `entering SAFE MODE`
   error — a clean start means the constitution parsed.

2. Confirm a custom (non-built-in) personality is back with its full toolset:

   ```
   ethos personality show <personality-id>
   ```

   The character sheet lists the personality's declared tools — not just the
   read-only file/web/memory reads that safe mode leaves behind.

3. Start a chat and run a tool that safe mode strips (a terminal command or a
   file write). It executes instead of being rejected as outside the toolset.
