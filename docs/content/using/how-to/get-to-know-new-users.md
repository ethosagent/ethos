---
title: "Let a personality get to know new users"
description: "Opt a personality into the get-to-know-you skill so it offers, on a new user's first DM, to learn about them, asking consent before every lookup and save."
kind: how-to
audience: user
slug: get-to-know-new-users
time: "10 min"
updated: 2026-09-29
---

## Task

Let a channel bot's personality offer to learn about a new user in their first direct message, and write only what that person agrees to.

## Result

- On a sender's first DM, when their `USER.md` is empty, the personality answers them and then offers once to get to know them.
- It asks "May I remember …?" before every save and "May I look up …?" before every lookup. One "yes" allows exactly one tool call.
- Agreed facts land in that sender's own `~/.ethos/users/<userId>/USER.md`. A user who says no leaves nothing behind.

## Prereqs

- A user-owned [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) bound to a channel bot under `ethos gateway start` or `ethos boot`.
- The gateway resolving senders to a user id. It does this for direct messages; see [Why are user profiles keyed by userId?](../explanation/user-profiles.md).

`ethos chat` and the web app have no sender user id, so they never run first contact.

## Steps

### 1. Opt the personality in

Add the bundled skill to the personality's `~/.ethos/personalities/<personality-id>/config.yaml`:

```yaml
skills.global_ingest.allow: ethos-bundled/personal/get-to-know-you
```

If the line already exists, add the name to its comma-separated list. A name also listed under `skills.global_ingest.deny` switches it off again. See [`skills.global_ingest.*`](../../building/reference/skills-tools.md#skills-global-ingest).

### 2. Give it the tools the skill uses

The skill saves with `memory_write`, so the personality's `toolset.yaml` must list it:

```yaml
- memory_read
- memory_write
```

Add `web_search` only if you want it able to look things up, after asking.

The registry reloads on the next turn. No restart is needed.

### 3. Send it a first DM

From an account the bot has not profiled yet, send it a direct message:

```text
hi
```

It answers, then offers once:

```text
Hi! What can I help with today? If you like, I can also learn a bit about you so I'm more useful next time. Totally optional.
```

Reply `sure`. It asks one question at a time, and before it saves anything:

```text
Nice to meet you, Alice. May I remember that your name is Alice?
```

Reply `yes`. It calls `memory_write` with `store=user` and one line, such as `Name: Alice`.

## How the consent gate works

While first contact is open for a session, a `before_tool_call` refusal decides every tool call. A refused call is never executed; the model gets an error result instead.

| Tool | Without a yes | After a yes |
|---|---|---|
| `memory_read`, `session_search`, `get_skill`, `skills_list`, `skill_view`, `clarify` | Runs | Runs |
| `delegate_task`, `mixture_of_agents`, `route_to_agent`, `dispatch_team`, `broadcast_to_agents`, `a2a_send`, `cron`, `watcher_create`, `watcher_resume`, `goal_create`, `process_start`, `kanban_create`, `kanban_create_goal`, `kanban_create_swarm`, `kanban_decompose`, `kanban_assign`, `kanban_update_status`, `kanban_unblock`, `kanban_complete`, `send_message`, `call`, `voice_session`, `meet_join` | Refused | Refused. The work they start runs later, reaches other people, or goes to another agent, where the consent count cannot follow. |
| Every other tool, including `memory_write`, lookups, `terminal`, MCP tools | Refused | One call, then refused again until the next yes |

A message counts as a yes only when both hold:

- It is a bare affirmative: "yes", "sure", "go ahead", "please do", "of course". "ok" and "okay" do not count.
- The personality's reply just before it asked a consent question: a sentence that starts with "May I …" and ends with "?", or starts with "Can I" followed by look, search, check, find, save, remember, note, store or read. "Can I help you with anything else?" is not a consent question. The skill always phrases it "May I …?".

Only the user's own next message counts. A "yes" typed as the answer to a `clarify` question does not arm consent: it comes back as the tool's result inside the running turn, not as a user message.

One yes allows one call. The call is identified by its tool-call id, tool name and a hash of its arguments. The same call fired again in the same step, as happens after an argument rewrite, still runs. Any different call is refused until the user says yes to a new question.

The gate opens when the sender's `USER.md` is empty and stays open for the rest of that session, even after the first fact is saved. `/new` starts a fresh session. It opens only in a direct message, never in a group or shared room.

The lists are `FIRST_CONTACT_ALLOWED_TOOLS` and `FIRST_CONTACT_REFUSED_TOOLS`, the consent checks are `isExplicitYes` and `askedForConsent`, the call identity is `callFingerprint`, and the hook is `createConsentRequiredToolsHook`, all in [`packages/wiring/src/first-contact.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/first-contact.ts). Pinned by `packages/wiring/src/__tests__/first-contact.test.ts`.

## Verify

Read the sender's profile. Find their userId on the web **Memory** page's **User** picker, or in `~/.ethos/users/identity-map.json`:

```bash
cat ~/.ethos/users/<user-id>/USER.md
```

```
Name: Alice
```

Then test a refusal. In a fresh first contact, reply `ok` instead of `yes` to a "May I remember …?" question. Nothing is written, and the personality asks again or moves on.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| The personality never offers | The skill is not in `skills.global_ingest.allow`, the sender's `USER.md` already has content, the chat is a group, or you are in `ethos chat` or the web app. | Check each. First contact is for a new sender's DM on a channel bot. |
| The skill is not loaded | `memory_write` is missing from `toolset.yaml`, so the skill filter hides the skill. | Add `memory_write`. |
| Every tool call is refused during the conversation | The gate is open and the user has not said a bare yes to a "May I …?" question. | Expected. Each yes allows one call. |
| The gate is gone after a restart | The gate lives in the gateway's memory. After a restart it is re-derived from `USER.md`, so a session whose `USER.md` already has a line is no longer gated. | Expected. |

## Known limits

- **Memory flush and capture are not gated.** The gate covers tool calls only. If the personality has the opt-in turn-end memory flush or memory capture enabled, those can write a fact the user never agreed to. Leave them off for a personality that uses this skill. [`memoryApproval.mode: automated`](../reference/config-yaml.md#memory-approval) parks capture writes until you approve them.
- **In-process only.** The gate is held in memory by one gateway process, so a restart or a busy gateway that evicts old sessions forgets it, as described above.
- **Which question a yes answered is not checked.** The skill asks one question per yes, and one yes allows one call, so a misread yes allows at most that one call.
