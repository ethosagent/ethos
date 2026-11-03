---
title: "Review a personality's change request"
description: "Let a personality ask for a tool it lacks with propose_self_amendment, then list and read its request; apply, decline or roll back is the next part."
kind: how-to
audience: user
slug: review-change-requests
time: "10 min"
updated: 2026-11-03
---

## Task

Let a personality ask you for a tool it keeps needing, and decide on each request from your terminal.

## Result

- The personality files a request with `propose_self_amendment`, and it waits for you. Nothing changes on its own.
- You read the exact file change and the permission diff before anything is written.
- You apply, decline or roll back with `ethos personality amendments`, and the web **Learning** page shows the same requests read-only.

## Prereqs

- A user-owned [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model). A built-in cannot be changed: duplicate it first with `ethos personality duplicate <built-in-id> <personality-id>`.
- A terminal on the machine that holds `~/.ethos/`.


## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-4: let the personality ask, know when a request is accepted, list and read the review |
| [Apply, decline or roll back](review-personality-change-requests/apply-decline-rollback.md) | Step 5: decide on a request, plus verify and troubleshoot |

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
| A conversation with a web page, MCP result, `session_search`, `get_session_events` or `get_observability` result, or attachment in its context | No — the agent is told to file from a fresh session |

A failed call counts as well as a successful one: a `terminal` command that exits 1 still printed what it fetched. Only the framework's own refusals, such as `Tool web_fetch is not permitted for this personality`, are not counted. A compacted conversation is checked in full when its summary was written from the earlier messages.

The check reads the conversation's stored messages, so it does not see text that reaches the prompt another way:

- `MEMORY.md` and `USER.md`. A fresh session does not reset memory: untrusted text that reached them earlier is in every later session.
- Project files: `AGENTS.md` or `CLAUDE.md` in the working directory, and skills in the project or your home directory. A personality that can write the working directory can edit them.
- Text a trusted tool shows from its own store, such as team memory, kanban comments, a scheduled job's output or a goal's output.
- A message an API key sent into your own web chat session. A stored message does not record how it was sent.

Read the rationale and evidence as the personality's claim either way.

A request is one of two kinds. A **toolset** request adds or removes entries in `toolset.yaml`. An **identity** request sets the personality's `name`, `description` and `display.emoji` in `config.yaml`; it grants nothing, so its review shows no permission rows. A new personality files one at the end of its [birth ritual](run-a-birth-ritual.md), and any personality holding the tool can file one later. Each personality holds at most 3 pending requests. A filing that your `~/.ethos/constitution.yaml` forbids is rejected on the spot and recorded as `auto_rejected`.

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
| `toolset.yaml` or `config.yaml` | The exact bytes that will be written. A toolset apply does not keep comments in `toolset.yaml`. An identity apply changes only its own lines of `config.yaml` and leaves every other line as it was. |
| Flags | `no-recorded-refusal`: no refused call was cited. `tool-unavailable`: the tool is not usable on this machine right now. |
| Rationale, Evidence | The personality's own words. Read them as a claim, not as fact. |

If the review starts with `! this personality can already edit its own definition — this review is not a boundary for it.`, the personality holds a shell tool and its tools run locally, not in the Docker sandbox. It can edit `toolset.yaml` directly, so the review protects nothing for it. Local execution is an operator setting, not a personality one: `execution.containerized: true` or `ETHOS_EXECUTION_BACKEND=local` says this deployment is itself the boundary, and `execution.allowLocalFallback: true` runs tools locally when Docker is missing. If that matters to you, remove those settings from `~/.ethos/config.yaml` and install Docker, so exec tools run in the sandbox, the default.

Continue with [Apply, decline or roll back](review-personality-change-requests/apply-decline-rollback.md).

## Verify

```bash
ethos personality amendments list
```

The request you filed shows status `pending` with the change it asks for, for example `+ web_extract`.

## Troubleshoot

**The personality is never offered `propose_self_amendment`.** The tool is missing from the personality's own `toolset.yaml`, or that toolset is empty or missing. Add `- propose_self_amendment` as in step 1.

**The filing is refused.** The conversation it came from is not one a request is accepted from. Check the table in step 2 and file from `ethos chat` or a web chat you are logged in to.

| Message | Cause | Fix |
|---|---|---|
| `An earlier apply was interrupted after it wrote toolset.yaml` in `show` | Ethos stopped between writing `toolset.yaml` and recording the apply. | Run `ethos personality amendments apply <id>`. It records the request as applied without writing anything, so you can roll it back. Decline is refused for it. If another request has since been applied with the same result, the interrupted one is not recorded twice: it stays `stale`, and you can decline it. |
