---
title: "Audit user identity mappings"
description: "Inspect which userId maps to which platform handle — useful for multi-user deployments where Telegram and Slack identities need linking."
kind: how-to
audience: user
slug: audit-user-identity
time: "5 min"
updated: 2026-09-13
---

## Task

Inspect and manage the mapping between platform identities (Telegram handle, Slack user ID, Discord user ID) and Ethos userId values.

## Result

A clear view of which platform identity maps to which userId and which USER.md each userId owns, and a safe way to link or unlink platform accounts.

## Prereqs

- Ethos installed, with the gateway (`ethos gateway start`) serving at least one channel adapter — Telegram, Slack, Discord, or email.
- At least one person has messaged the agent through that channel, so the identity map has an entry.
- Shell access to the machine that runs the gateway. Nothing needs to be stopped to edit the map.

## How a userId is assigned

The first time a platform identity sends a message, the gateway calls `IdentityMap.resolve` ([`packages/wiring/src/identity-map.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/identity-map.ts)). It mints a random 12-character hex id, appends an entry to `~/.ethos/users/identity-map.json`, and reuses that id for every later message from the same platform and platform user. The adapter only reports the platform's own sender id; it does not choose the userId.

`ethos chat` resolves no user at all, so it never writes to the map. `ethos serve` records one entry, `desktop`, when it starts.

## Steps

### 1. See known users in the web dashboard

1. Start the dashboard: `ethos serve --web`.
2. Open **Memory**, stay on the **Files** tab, and select the **USER.md** tab.
3. Open the **User** dropdown next to the personality picker.

The dropdown lists every entry in the identity map by its display label — the sender's platform username when the adapter reports one, otherwise `<platform>:<platform-user-id>` — from the `memory.listUsers` RPC. **Shared (personality default)** is the personality's own `USER.md`. Picking a user shows and edits that user's `USER.md`:

```
User  ▾
  Shared (personality default)
  Desktop
  sample_user
  telegram:123456789
```

The dropdown shows labels, not userIds or platform ids. For the full mapping, read the file (step 2).

There is no CLI command that lists users.

### 2. Inspect the raw identity map file

```bash
cat ~/.ethos/users/identity-map.json
```

The file is a JSON array with one entry per platform identity:

```json
[
  {
    "platform": "telegram",
    "platformUserId": "123456789",
    "userId": "a1b2c3d4e5f6",
    "displayLabel": "sample_user",
    "firstSeenAt": "2026-09-01T10:00:00.000Z"
  },
  {
    "platform": "slack",
    "platformUserId": "U0123ABCDEF",
    "userId": "b7c8d9e0f1a2",
    "displayLabel": "sample.user",
    "firstSeenAt": "2026-09-02T14:30:00.000Z"
  }
]
```

Each userId owns `~/.ethos/users/<userId>/USER.md`. Two entries with the same `userId` are one person across two platforms.

### 3. Edit while Ethos runs

Edit the file with `ethos gateway` and `ethos serve` running. Save it in one write, and keep it valid JSON.

Each running process re-reads `identity-map.json` whenever its modification time changes, so your edit applies from the next message. When a process records a new user, it re-reads the file just before writing and adds only that one entry, so entries you added, changed, or removed stay as you left them (`IdentityMap` in `packages/wiring/src/identity-map.ts`).

If two processes record a new user at the same instant, both entries are kept. A process holds `~/.ethos/users/identity-map.json.lock` while it records a user, and the other process waits for it (`acquireIdentityMapLock` in `packages/wiring/src/identity-map.ts`). The wait lasts up to 10 seconds, and a lock left by a process that is gone is taken over. If the wait runs out, the map is not changed and that sender's message fails. Their next message tries again. The error names the process that holds the lock.

The lock has limits:

| Case | What happens |
|---|---|
| You save a hand edit made from a copy read before a new user was recorded | Your save replaces that new entry. Editors do not take the lock. Re-open the file just before you save. |
| Two machines share one `~/.ethos` over a network filesystem | The lock cannot tell whether the other machine's process is running, and both can write at once. Run every Ethos process that shares a data directory on one machine. |
| The filesystem has no reliable exclusive create (for example NFSv2) | The lock does not hold, and one of two simultaneous new users can be lost. |

### 4. Link two platform identities to the same userId

When the same person uses several platforms and you want one `USER.md`:

1. Open `~/.ethos/users/identity-map.json` in your editor.
2. Find both entries. They have different `userId` values.
3. Set one entry's `userId` to the other's. Keep the userId whose `USER.md` has more content.
4. If the dropped userId's `USER.md` has useful content, append it to the kept one:
   ```bash
   cat ~/.ethos/users/<old-userId>/USER.md >> ~/.ethos/users/<kept-userId>/USER.md
   ```
5. Review and deduplicate the merged file.
6. Remove the orphaned directory: `rm -r ~/.ethos/users/<old-userId>/`.

### 5. Unlink a platform identity

Remove that entry from `identity-map.json`. The next message from that platform identity makes the gateway mint a fresh random userId, and its `USER.md` starts empty.

## Verify

1. Validate the file after editing:
   ```bash
   node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/.ethos/users/identity-map.json', 'utf8')).length)"
   ```
   ```
   2
   ```
   The number is the entry count. A syntax error here means running processes stop recording new users until you fix it.
2. Send a test message from a linked platform, and check that the agent refers to the kept `USER.md` content.

## Troubleshoot

**New senders are not added to `identity-map.json`.**
The file is not valid JSON. Known users keep resolving from the last good copy, but no process writes over a file it cannot parse. Run the Verify command, fix the syntax error, and save.

**A new sender's message fails with `identity map: … identity-map.json.lock is still held by process <pid>`.**
Another process held the lock for more than 10 seconds, so the sender was not recorded. Their next message tries again. If it keeps failing, run `ps -p <pid>`. Delete `~/.ethos/users/identity-map.json.lock` only once that process is gone.

**A user is missing from the web dashboard's User dropdown.**
The gateway has not seen a message from that user yet. Reload the Memory page after they send one.

**Two people share the same userId unexpectedly.**
Check `identity-map.json` for a copy-paste error in a `userId` field. Fix the entry and save.

**A user's preferences do not carry over between platforms.**
Their platform identities are not linked. Follow step 4 to give both entries the same `userId`.

**The identity map file does not exist.**
No gateway has seen a sender yet and `ethos serve` has not run. The gateway creates the file on the first inbound message that carries a sender id.

## See also

- [Why are user profiles keyed by userId?](../explanation/user-profiles.md) -- design rationale for per-user, not per-personality, profiles
- [Why MEMORY.md and USER.md?](../explanation/memory-model.md) -- how USER.md fits into the memory model
- [Security controls](../../security/controls.md) -- injection scanning on memory content, including USER.md
