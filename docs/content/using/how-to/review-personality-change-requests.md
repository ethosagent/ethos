---
title: "Review a personality's change request"
description: "Let a personality ask for a tool it lacks with propose_self_amendment, then review, apply, decline or roll back the request from the CLI."
kind: how-to
audience: user
slug: review-change-requests
time: "10 min"
updated: 2026-09-28
---

## Task

Let a personality ask you for a tool it keeps needing, and decide on each request from your terminal.

## Result

- The personality files a request with `propose_self_amendment`, and it waits for you. Nothing changes on its own.
- You read the exact `toolset.yaml` change and the permission diff before anything is written.
- You apply, decline or roll back with `ethos personality amendments`, and the web **Learning** page shows the same requests read-only.

## Prereqs

- A user-owned [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model). A built-in cannot be changed: duplicate it first with `ethos personality duplicate <built-in-id> <personality-id>`.
- A terminal on the machine that holds `~/.ethos/`.

## Steps

### 1. Let the personality ask

Add the tool to the personality's own `~/.ethos/personalities/<personality-id>/toolset.yaml`:

```yaml
- propose_self_amendment
```

Only a personality that lists the tool is offered it. A personality whose toolset is empty or missing cannot file.

### 2. Know when a request is accepted

The personality can file only for itself, and only from a conversation you started:

| Filed from | Accepted |
|---|---|
| `ethos chat`, or a web chat you are logged in to | Yes |
| A web chat driven by an API key | No |
| Telegram, Slack, Discord, WhatsApp, email | No |
| A cron job, watcher, goal, background job or delegated sub-agent | No |
| A conversation with a web page, MCP result, `session_search` result or attachment in its context | No — the agent is told to file from a fresh session |

A failed call counts as well as a successful one: a `terminal` command that exits 1 still printed what it fetched. Only the framework's own refusals, such as `Tool web_fetch is not permitted for this personality`, are not counted. A compacted conversation is checked in full when its summary was written from the earlier messages.

A fresh session does not reset memory. If untrusted text reached `MEMORY.md` or `USER.md` in an earlier session, the memory snapshot carries it into every later session, and this check does not see it. Read the rationale and evidence as the personality's claim either way.

A request adds or removes toolset entries. Each personality holds at most 3 pending requests. A filing that your `~/.ethos/constitution.yaml` forbids is rejected on the spot and recorded as `auto_rejected`.

When the personality files, the chat shows the id:

```
✓ ┊ propose_self_amendment · I keep needing to read full pages the user links; web_extract would let me.
Filed amendment a-mukzpjf2-qiiphi. It is pending your owner's review; nothing changes until they apply it.
```

### 3. List what is waiting

```bash
ethos personality amendments list
```

```
ID                 PERSONALITY  CHANGE         STATUS   FILED
a-mukzpjf2-qiiphi  scout        + web_extract  pending  2026-09-28T08:33
```

`--all` lists every status, `--personality <personality-id>` filters, and `--json` prints the records. The web **Learning** badge counts pending requests too.

### 4. Read the review

```bash
ethos personality amendments show a-mukzpjf2-qiiphi
```

```
Amendment a-mukzpjf2-qiiphi  [pending]
  Personality: scout
  Change:      + web_extract

  Permission diff
    WIDENS  Toolset: + web_extract
    Not compared: safety.injectionDefense, safety.allowed_skill_permissions, ...

  toolset.yaml
     - think_deeper
     - propose_self_amendment
    +- web_extract

  Flags        no-recorded-refusal
  Rationale    (written by the personality — untrusted)
    I keep needing to read full pages the user links; web_extract would let me.
  ...
  Review hash  3426abdfb136ecb44153c335e3c051649fbd6940c8ffef95d549e2083e8e9b38
```

Every part is recomputed from the live files each time you run `show`:

| Part | What to look for |
|---|---|
| Permission diff | `WIDENS` rows give the personality more reach. `[high-risk]` marks a tool that can run code, write files, spawn agents or create personalities. `[team-workflow]` marks the removal of a tool a team member needs to report its work. |
| `toolset.yaml` | The exact bytes that will be written. Comments in the file are not kept. |
| Flags | `no-recorded-refusal`: no refused call was cited. `tool-unavailable`: the tool is not usable on this machine right now. |
| Rationale, Evidence | The personality's own words. Read them as a claim, not as fact. |

If the review starts with `! this personality can already edit its own definition — this review is not a boundary for it.`, the personality holds a shell tool and its tools run locally, not in the Docker sandbox. It can edit `toolset.yaml` directly, so the review protects nothing for it. Local execution is an operator setting, not a personality one: `execution.containerized: true` or `ETHOS_EXECUTION_BACKEND=local` says this deployment is itself the boundary, and `execution.allowLocalFallback: true` runs tools locally when Docker is missing. If that matters to you, remove those settings from `~/.ethos/config.yaml` and install Docker, so exec tools run in the sandbox, the default.

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

Run `ethos personality show <personality-id>` and read the toolset. After an apply it lists the new tool, and the next turn is offered it. `ethos audit decisions` records every apply, decline and rollback.

## Troubleshoot

| Message | Cause | Fix |
|---|---|---|
| `FORBIDDEN: apply and rollback need an interactive terminal` | stdin or stdout is not a TTY: a pipe, a script, or `< /dev/null`. | Run the command yourself in a terminal. |
| `FORBIDDEN: ETHOS_TOOL_PROCESS=1: ...` | The command ran inside a process an agent's `terminal`, `process_start` or code tool started. | Run it from your own terminal. The check is a tripwire, not a boundary: `env -u ETHOS_TOOL_PROCESS` defeats it. |
| `FORBIDDEN: Confirmation did not match` | The typed id differed from the personality id. | Re-run and type the id exactly. |
| `CONFIG_CONFLICT: ... is stale` | `toolset.yaml` changed after the request was filed. | Decline it. The personality can file again against the new file. |
| `An earlier apply was interrupted after it wrote toolset.yaml` in `show` | Ethos stopped between writing `toolset.yaml` and recording the apply. | Run `ethos personality amendments apply <id>`. It records the request as applied without writing anything, so you can roll it back. Decline is refused for it. |
| `FORBIDDEN: ... constitution ...` | `~/.ethos/constitution.yaml` forbids the result. | Nothing was written. Change the constitution first if you still want it. |
| `FORBIDDEN: ... already forbids <personality-id>'s current definition` | The personality breaks the constitution without this change, often a `${CWD}` rule read from the directory you ran the command in. | Nothing was recorded. Fix the personality or the constitution, or run the command from the directory the rule expects. |
| `CONFIG_CONFLICT: ... does not match the bytes it applied` | The stored request or its saved `toolset.yaml` was edited on disk. | Nothing was rolled back. Restore `toolset.yaml` by hand. |

The web **Learning** page has no apply button in this release. It shows each pending request with its permission diff and the command to run.
