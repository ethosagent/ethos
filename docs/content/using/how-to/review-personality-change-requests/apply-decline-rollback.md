---
title: "Review a personality's change request: apply, decline or roll back"
description: "Apply, decline or roll back a personality change request from your own terminal"
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Apply, decline or roll back a pending change request from your own terminal, after reading its review.

## Result

An applied request writes exactly the reviewed bytes to the personality's `toolset.yaml`; a declined one records your reason; a rollback restores the saved file.

## Prereqs

- Complete [part 1](../review-personality-change-requests.md): a request is pending in `ethos personality amendments list` and you have read it with `show`.
- An interactive terminal run by you: apply and rollback refuse a pipe or a script.

## Steps

### 5. Apply, decline or roll back

Apply it in your own terminal. The command prints the review again and asks you to type the personality id:

```bash
ethos personality amendments apply a-mukzpjf2-qiiphi
```

```
Type the personality id (scout) to apply: scout
✓ Applied a-mukzpjf2-qiiphi to scout's toolset.yaml. Other processes pick it up on their next turn.
Undo with: ethos personality amendments rollback a-mukzpjf2-qiiphi
```

Apply writes exactly the bytes the review showed, onto exactly the file the request was filed against. If `toolset.yaml` changed in between, it refuses, writes nothing, and marks the request `stale`. A stale request no longer counts toward the 3 pending.

Decline a request you do not want. A reason is required:

```bash
ethos personality amendments decline a-mukzpjf2-qiiphi --reason "use web_search instead"
```

```
✓ Declined a-mukzpjf2-qiiphi.
```

Roll back an applied request. It restores the `toolset.yaml` saved at apply time, after the same typed confirmation:

```bash
ethos personality amendments rollback a-mukzpjf2-qiiphi
```

The command first prints the `toolset.yaml` change the rollback makes:

```
Roll back a-mukzpjf2-qiiphi — scout
  Undoes: + web_extract
  Restores the toolset.yaml saved when it was applied (2026-09-28T08:41:10.118Z).
  Refused if toolset.yaml was edited since, or the constitution forbids the result.

  toolset.yaml (live → restored)
     - think_deeper
     - propose_self_amendment
    -- web_extract

Type the personality id (scout) to roll back: scout
✓ Rolled back a-mukzpjf2-qiiphi; scout's toolset.yaml is restored.
```

Rollback refuses when the stored request or its saved `toolset.yaml` was edited on disk and no longer matches the bytes the apply wrote.

If you applied several requests to one personality, roll them back newest first.

## Verify

Print the personality's character sheet and read its toolset:

```bash
ethos personality show scout
```

After the apply above, the `## Toolset` section lists the new tool:

```
## Toolset
3 tools:
- think_deeper
- propose_self_amendment
- web_extract
```

The next turn is offered it. `ethos audit decisions` records every apply, decline and rollback.

## Troubleshoot

| Message | Cause | Fix |
|---|---|---|
| `FORBIDDEN: apply and rollback need an interactive terminal` | stdin or stdout is not a TTY: a pipe, a script, or `< /dev/null`. | Run the command yourself in a terminal. |
| `FORBIDDEN: ETHOS_TOOL_PROCESS=1: ...` | The command ran inside a process an agent's `terminal`, `process_start` or code tool started. | Run it from your own terminal. The check is a tripwire, not a boundary: `env -u ETHOS_TOOL_PROCESS` defeats it. |
| `FORBIDDEN: Confirmation did not match` | The typed id differed from the personality id. | Re-run and type the id exactly. |
| `CONFIG_CONFLICT: ... is stale` | `toolset.yaml` changed after the request was filed. | Decline it. The personality can file again against the new file. |
| `FORBIDDEN: ... constitution ...` | `~/.ethos/constitution.yaml` forbids the result. | Nothing was written. Change the constitution first if you still want it. |
| `FORBIDDEN: ... already forbids <personality-id>'s current definition` | The personality breaks the constitution without this change, often a `${CWD}` rule read from the directory you ran the command in. | Nothing was recorded. Fix the personality or the constitution, or run the command from the directory the rule expects. |
| `CONFIG_CONFLICT: ... does not match the bytes it applied` | The stored request or its saved `toolset.yaml` was edited on disk. | Nothing was rolled back. Restore `toolset.yaml` by hand. |

The web **Learning** page has no apply button in this release. It shows each pending request with its permission diff and the command to run.
