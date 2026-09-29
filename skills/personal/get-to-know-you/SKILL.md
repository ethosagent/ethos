---
name: get-to-know-you
description: Get to know a new user on first contact, with their consent. Offer once, ask a few light questions, and ask "May I look up X?" or "May I remember X?" before every lookup and every save. One yes allows one call.
version: 1.0.0
author: ethosagent
tags: [personal, onboarding, memory, consent]
required_tools: [memory_write]

ethos:
  category: personal
  default_personalities: []
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [web_search, web_extract]
  integrates_with:
    - tool: memory_write
      role: the only place a confirmed fact goes. Always `store=user`, `action=add`, one short line per fact, and only after the user said yes to "May I remember …?" in the same turn. The runtime refuses every memory write without that yes.
    - tool: web_search
      role: optional, one lookup per yes. The runtime refuses a lookup until the user's message in this turn is a clear yes to your "May I look up …?" question, and a yes buys exactly one call.
  surface_metadata:
    invocation_trigger: "the system prompt says this is a first contact and the user has no profile yet; or the user says 'get to know me', 'remember me', 'what do you know about me'"
    estimated_turns: "2-6"
---

# Get to know you

The user is new to you and you know nothing about them yet. You can offer to learn a little about them so you help them better later. This is their choice. Getting it wrong costs their trust, so follow every rule below.

## Rules

1. **Answer first.** If the user asked for something, help with that first. Offer to get to know them once, in one sentence, at the end of a reply. If they ignore the offer or say no, drop it and do not offer again in this conversation.
2. **One question at a time.** Ask one short question per reply. Good ones:
   - What should I call you?
   - What do you do, or what are you working on these days?
   - How do you like answers: short and direct, or with more detail?
   - Is there anything you'd like me to always keep in mind?
   The user can skip any question. A skipped question stays skipped.
3. **Ask before every save.** Before you save a fact, ask "May I remember that <fact>?" Save it only if their next message is a clear yes. Then call `memory_write` with `store=user`, `action=add`, and one short line, for example `Name: Alice`. Never save something they did not agree to. Never save a guess.
4. **Ask before every lookup.** Before any lookup (web search, reading a page, searching a social site, running a command), ask "May I look up <exactly what>?" and wait for their reply.
5. **No means no.** If they say no, or anything that is not a clear yes, do not look anything up and do not write anything. Say "No problem" and carry on with what they came for.
6. **How the runtime checks consent.** While you are getting to know someone, the runtime refuses every tool except reading memory, searching this conversation, reading skills and `clarify`, unless the user's message in this turn is a clear yes ("yes", "sure", "go ahead"; "ok" does not count) AND your reply just before it asked a question starting "May I" and ending with "?". Always phrase it "May I …?" (never "Can I …?" or "Shall I …?"), and ask it as the last thing in your reply. A yes given as an answer to `clarify` does not count; only the user's own next message does. One yes allows one call: one lookup OR one save, not both. For the next call, ask again. This lasts for the whole conversation, even after you have saved the first fact.
7. **Do it yourself.** `delegate_task`, `dispatch_team`, `route_to_agent`, `mixture_of_agents`, `broadcast_to_agents`, `a2a_send`, `cron`, `watcher_create`, `watcher_resume`, `goal_create`, `process_start`, `send_message`, `call`, `meet_join` and the kanban tools that create, assign, unblock, complete or change a ticket's status are refused during this conversation, yes or no, because the work they start runs later, reaches other people, or goes to another agent, where the user's consent cannot follow it.
8. **Private only.** This skill is for one-to-one conversations. Never ask personal questions, look anyone up, or save a profile in a group or shared room.
9. **Be plain about what you keep.** If they ask what you know about them, tell them exactly what you saved. If they ask you to forget something, confirm with "May I remove <fact>?", then remove it with `memory_write` `store=user`, `action=remove` after their yes.

## What a good first contact looks like

> **User:** hi
> **You:** Hi! What can I help with today? If you like, I can also learn a bit about you so I'm more useful next time. Totally optional.
> **User:** sure
> **You:** Great. What should I call you?
> **User:** Alice
> **You:** Nice to meet you, Alice. May I remember that your name is Alice?
> **User:** yes
> **You:** *(calls `memory_write` store=user action=add "Name: Alice")* Done. What are you working on these days?
