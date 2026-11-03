---
title: "Why does private memory stay out of shared rooms?"
description: "Which rooms are shared, what a shared turn loses, and the known limits."
kind: explanation
audience: user
updated: 2026-11-03
---

## Context

This page covers why turns in group chats do not read or write private memory.

## Discussion

### Private memory stays out of shared rooms

`MEMORY.md` and `USER.md` are written from your private conversations. A group chat has other readers, so a turn there is shared: the gateway marks it (`Gateway.audienceFor`, `extensions/gateway/src/index.ts`) and the agent core enforces it in one place (`resolveTurnAudience`, `packages/core/src/agent-loop/audience.ts`), pinned end to end by `extensions/gateway/src/__tests__/memory-boundary-e2e.test.ts`. The channel adapter does not decide what a shared turn may touch; it only reports what kind of chat the message came from. A group the operator trusts can be listed under `gateway.private_chats.<platform>`: after a gateway restart, it and every thread in it are private again and get memory back. [Keep memory out of group chats](../../how-to/group-chat-memory.md) walks through it.

#### Which rooms are shared

| Chat | Room audience |
|---|---|
| A direct message to the bot from you | private |
| A group, channel or supergroup | shared |
| A thread or topic | the same as its parent chat |
| An email whose sender the mail server did not authenticate | shared (still answered) |
| A Discord group DM | shared |
| A WhatsApp status broadcast, `@broadcast` list or `@newsletter` channel | shared |
| A group listed under `gateway.private_chats.<platform>` | private |

A direct message from someone else, on a platform with `channel_filter.<platform>.ownerUserId` set, is a middle case. `MEMORY.md` is yours, so it is withheld, and so is everything else a shared turn loses. The sender's own profile, `~/.ethos/users/<their-user-id>/USER.md`, is still read. With no owner configured there is nobody to compare against, and a direct message is private.

Work that runs later inherits the room it came from. It runs shared when the chat that created it was shared, or when it posts into a shared chat:

| Runs later | Room audience |
|---|---|
| A cron job | shared if it was created in a shared chat, delivers to one, or reads a shared job's output through `contextFrom` |
| A watcher wake | shared if a shared chat created the watcher, it delivers to one, or nothing records who created it |
| A goal | the room audience of the chat it was set in (`web` and CLI goals are private); a shared turn with no room of its own, such as a delegated sub-agent, cannot create one |
| A kanban task a shared turn created | shared, including on a team member it is dispatched to; a task created on the web board, from the CLI, or before this release carries no stamp and runs private |
| An inbound webhook | shared, unless the hook sets `webhooks.<hook-id>.private: true` and every `deliver` target is private |
| An A2A request, a phone caller, an MCP client (unless `expose_memory` is set) | shared |

A job created before this release carries no stamp and is judged by where it delivers: a group, a Discord channel or an email address runs shared, and a job with no delivery target runs private. The cron runner logs one line for each such job it runs shared.

#### What a shared turn loses

- `MEMORY.md`, `USER.md` and the per-user `USER.md` are not read into the prompt.
- These tools are not offered and are refused if called: `memory_read`, `memory_write`, `session_list_by_date`, `get_session_events`, `get_observability`, the `team_memory_*` tools, `meet_join`, `terminal`, `run_code`, `run_tests`, `lint`, the `process_*` tools, `dashboard_add_panel`, `dashboard_update_panel`, `dashboard_import`, `dashboard_set_params`, `dashboard_export`, `route_to_agent`, `dispatch_team`, `broadcast_to_agents` and the `skills_pending_*` tools (`SHARED_AUDIENCE_EXCLUDED_TOOLS`, same file). `session_search` stays: it reads the current chat only.
- The turn-end memory flush does not run.
- File tools read nothing under `~/.ethos` except the personality's own `files/` and `ui/` folders, its own `SOUL.md` and skills, the skills in `~/.ethos/skills/`, and the attachments sent with the message being answered, and write only its own `files/` and `ui/`. Scheduled-job output, compaction transcripts, `sessions.db`, the job, board and goal stores, `config.yaml`, other conversations' attachments and every other personality's directory are refused, and so are the private memory files anywhere they live (a configured vault included). Letter case and macOS's other spellings of the same path — `/System/Volumes/Data/…` and `/.nofollow/…` — make no difference, and a path spelled by inode number (`/.vol/…`, `/.resolve/…`) is refused on every turn. `image_generate` saves to `~/.ethos/generated/` by default, which a shared turn cannot write; in a group it needs an `output_path` under the personality's own `files/` folder.
- `/learn` answers with a pointer to a private chat instead of running.
- A `/background` job, a delegated sub-agent and a background job's review turn launched from the group run shared too. A shared review of a job whose chat is a direct message runs in its own session, so it never marks the direct message shared.
- The `cron` tool sees and acts on only the jobs stamped shared: listing, showing, reading runs, editing, pausing, resuming, running and removing any other job answers as if it did not exist, and creating a job whose name is taken gets one answer that names no job. A job created from the group can take its context (`context_from`) only from a job stamped shared — any other name gets the same "unknown job" answer as a job that does not exist — and when a job that runs shared fires, it skips the output of any job it names that does not. `goal_status` shows only goals this personality set in a shared room.
- The board tools see only tasks stamped shared: `kanban_list` leaves the others out, and `kanban_show`, status changes, comments, blocks, assignment and the rest answer as if the task did not exist. `kanban_create` answers a hidden parent as a missing one, and refuses an `idempotency_key` that already belongs to a hidden task.
- The watcher tools list, pause, resume and delete only watchers created in a shared room.

A session that has run one shared turn stays shared for good, whichever surface opens it next. A group session from before the upgrade, opened from the web app or forked, runs shared too, and so does its fork. That is why the stamp is one-way: a session's history may already quote the room, and trusting it later cannot take that back.

After the turn, nothing said in a shared session feeds private learning. Memory capture, the skill-improvement fork, the nightly Judge and Expression evidence, learning cases, `ethos evolve run` and the web Expression draft all skip it, and `get_session_events` refuses it to any other session. The same goes for a direct message from someone other than the owner. Group sessions from before the upgrade, which carry no stamp, are recognised by their session key and skipped too. A listed trusted room, and a Discord or email direct message the gateway judged private, are not skipped.

#### Known limits of shared rooms

These paths do not withhold memory today:

- A kanban task with no stamp — created on the web board, from the CLI, or before this release — runs private, even if the work came from a group.
- A dashboard panel added from a group before this release refreshes with private memory until it is removed and added again from a direct message or the web app.
- A turn from `ethos chat -q` records no initiator, so it cannot file a personality change request.
- Plugin `before_prompt_build` hooks and OpenClaw `agent_end` / `agent_done` hook payloads carry no room audience; a plugin cannot tell a group turn from a private one.
- A context engine's `onTurnComplete` hook is not told the room audience, and its per-personality store under `~/.ethos/compaction/<id>/` serves private and shared sessions alike. Of the built-in engines only `tiered_summary` uses it, and only to write the messages it elides; a third-party engine that reads that store back across sessions can carry private text into a room.
- MCP tools run in the operator's MCP server processes; one that reads files can read `MEMORY.md` on a shared turn. A personality that talks in groups should not hold an MCP server with file access to `~/.ethos`.

## Trade-offs

See [Trade-offs](../memory-model.md#trade-offs) on [Why MEMORY.md and USER.md, not a vector store?](../memory-model.md).

## See also

- [Why MEMORY.md and USER.md, not a vector store?](../memory-model.md) — the parent page.
