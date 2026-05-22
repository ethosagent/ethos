---
title: "Audit user identity mappings"
description: "Inspect which userId maps to which platform handle — useful for multi-user deployments where Telegram and Slack identities need linking."
kind: how-to
audience: user
slug: audit-user-identity
time: "5 min"
updated: 2026-05-22
---

## Task

Inspect and manage the mapping between platform identities (Telegram handle, Slack user ID, Discord user ID) and Ethos userId values.

## Result

A clear view of which platform identity maps to which userId, which USER.md each userId owns, and the ability to link or unlink platform accounts.

## Prereqs

- Ethos installed and configured with at least one channel adapter running (Telegram, Slack, Discord, or email).
- At least one user has interacted with the agent, so the identity map is populated.
- Admin access to the Ethos deployment (shell access or web dashboard access).

## Steps

### 1. View the identity map from the CLI

```bash
ethos users list
```

This prints a table of all known userId values with their associated platform identities and USER.md paths:

```
userId          platform           handle              USER.md
──────────────  ─────────────────  ──────────────────  ────────────────────────────────────
a1b2c3d4e5f6    telegram:123456    @alice              ~/.ethos/users/a1b2c3d4e5f6/USER.md
                slack:U0123ABC     alice.chen
                email              alice@example.com
g7h8i9j0k1l2    discord:98765...   bob#1234            ~/.ethos/users/g7h8i9j0k1l2/USER.md
```

A userId with multiple rows means multiple platform identities are linked to the same user profile.

### 2. View the identity map from the web dashboard

1. Start the web dashboard: `ethos serve --web`.
2. Navigate to **Users** (or **Memory** and select the **User** dropdown).
3. The identity map view lists all known userIds with their platform associations, USER.md path, and last-modified timestamp.

### 3. Inspect the raw identity map file

The identity map lives at `~/.ethos/users/identity-map.json`. Read it directly:

```bash
cat ~/.ethos/users/identity-map.json
```

The file maps platform-specific sender identifiers to userId values:

```json
{
  "telegram:123456789": "a1b2c3d4e5f6",
  "slack:U0123ABCDEF": "a1b2c3d4e5f6",
  "discord:987654321012345678": "g7h8i9j0k1l2",
  "email:alice@example.com": "a1b2c3d4e5f6"
}
```

### 4. Link two platform identities to the same userId

When the same person uses multiple platforms and you want them to share a single USER.md:

1. Open `~/.ethos/users/identity-map.json` in your editor.
2. Find both platform entries. They will have different userId values.
3. Change one to match the other — pick the userId with the richer USER.md.
4. If the old userId's USER.md has useful content, merge it into the kept USER.md:
   ```bash
   cat ~/.ethos/users/<old-userId>/USER.md >> ~/.ethos/users/<kept-userId>/USER.md
   ```
5. Review and deduplicate the merged file.
6. Remove the orphaned directory: `rm -r ~/.ethos/users/<old-userId>/`.

### 5. Unlink a platform identity

To disconnect a platform identity from a userId, remove its entry from `identity-map.json`. The next time that platform identity sends a message, the adapter generates a fresh userId and creates a new USER.md.

## Verify

After editing `identity-map.json`:

```bash
ethos users list
```

Confirm the updated mapping shows the correct associations. Then send a test message from the linked platform and verify the agent references the correct USER.md content in its response.

## Troubleshoot

**"ethos users list" shows a userId with no platform associations.**
The identity map entry was deleted but the user directory still exists. Either re-add the platform entry to `identity-map.json` or remove the orphaned directory.

**Two users share the same userId unexpectedly.**
Check `identity-map.json` for a copy-paste error. Each platform identity should map to the correct userId. Fix the mapping and restart the gateway.

**A user's preferences are not carrying over between platforms.**
Their platform identities are not linked. Follow Step 4 above to point both platform keys at the same userId.

**The identity map file does not exist.**
No users have interacted with the agent yet. The file is created automatically when the first message arrives from a platform adapter. In CLI-only mode, the file exists but contains only the single machine-derived userId.

## See also

- [Why are user profiles keyed by userId?](../explanation/user-profiles.md) -- design rationale for per-user, not per-personality, profiles
- [Why MEMORY.md and USER.md?](../explanation/memory-model.md) -- how USER.md fits into the memory model
- [Security controls](../../security/controls.md) -- injection scanning on memory content, including USER.md
