---
title: "Share a session as a read-only link"
description: "Publish a redacted, expiring, read-only copy of one chat at a link a teammate opens without signing in, then list and revoke it from the web UI or CLI."
kind: how-to
audience: user
slug: share-a-session
time: "10 min"
updated: 2026-11-26
---

## Task

Show a teammate what the agent did with one link instead of screenshots. The link opens a plain page with the conversation, no sign-in and no JavaScript.

## Result

- A URL like `https://ethos.example.com/share/<token>` that anyone who holds it can read until it expires or you revoke it.
- The page is a frozen copy taken when you create the link. Later turns never appear on it.
- Secrets and personal data are redacted once, at creation. You can read the redacted copy before the link exists (web UI only).

Ethos never uploads the copy anywhere. The link points at your own Ethos web port, so your teammate must be able to reach it.

## Prereqs

- A running [web dashboard](use-web-dashboard.md) (`ethos serve`) for readers to reach, and a private session to share.
- Access to `~/.ethos/config.yaml`.
- The web UI shows **Share…** only while `shareLinks.enabled` is `true`. It reads that setting through a cache of up to about 30 seconds, so after you turn it on, wait a moment or reload the page.

## Steps

1. Turn the feature on. It is off by default. Add this line to `~/.ethos/config.yaml`:

   ```yaml
   shareLinks.enabled: true
   ```

   Optionally keep some personalities out of sharing: `shareLinks.excludePersonalities: ops, legal`. Both keys are in the [config.yaml reference](../reference/config-yaml/operations.md#share-links).

2. Set the address readers will use. If `webBaseUrl` is unset, the link is built from the host and port `ethos serve` binds, which is `http://127.0.0.1:3000` by default and opens only on your machine. Set it to the origin your teammates reach. Ethos reads it on each share, so no restart is needed:

   ```yaml
   webBaseUrl: https://ethos.example.com
   ```

   | Where Ethos runs | What to set |
   |---|---|
   | Laptop or desktop app | Nothing for yourself. Set `webBaseUrl` and expose the port before you send a link to anyone else. |
   | Docker | Add `webBaseUrl` to the `config.yaml` in the state volume: the host and mapped port, for example `http://ethos-host:3000`. The container must bind `ETHOS_WEB_HOST=0.0.0.0` ([Docker](run-in-docker/healthcheck-run-kubernetes.md)), and a wildcard bind is why Ethos cannot guess the address. |
   | Helm | The chart has no `webBaseUrl` value, and first-boot provisioning (`ethos setup --from-env`) does not write one. Edit `config.yaml` on the state volume (`/home/ethos/.ethos/config.yaml`) by hand and set `webBaseUrl` to the ingress origin, for example `https://ethos.example.com`. The chart's ingress routes `/` to the pod, so `/share/*` needs no extra path. |

3. Share from the web UI (Recommended). **Share…** lives in two places: the row action menu (the three dots) on the Sessions page, and the right-click menu on a session in the sidebar's recent list. It is not in the open chat view. Incognito sessions do not offer it. In the dialog, pick:

   - **Link expires after**: 1 hour, 1 day, 7 days (the default) or 30 days. There is no "never".
   - **Include tool names**: off by default. Adds the names of the tools the agent called, with a failed flag, and nothing else about them. If the conversation is too large to share with tool names on, the dialog says so and keeps the toggle available: turn it off and try again.
   - **Redact personal info**: on by default. Hides emails, phone numbers, card numbers, SSNs and IBANs. Secrets are redacted either way.

   The dialog shows a preview of the redacted copy. Read it, then choose **Create link**. Copy the link now: the dialog shows it once.

4. Or share from the CLI. Run:

   ```bash
   ethos sessions share <session-id> --expires 7d --tools
   ```

   ```
   Share link created  (prefix Qm9yZWRQ, expires 2026-12-03T14:20:00.000Z)

     https://ethos.example.com/share/Qm9yZWRQYW5kYUZvclRlc3RpbmdPbmx5MTIzNDU2Nzg5MA

   You won't see this link again. Revoke it with `ethos sessions share revoke <prefix>`.
   ```

   `--tools` turns tool names on, `--no-pii` keeps personal data, `--json` prints one JSON document. The CLI has no preview, so use the web UI when the content is sensitive. The command refuses to create a link when it runs inside a process an agent's tool started (`ETHOS_TOOL_PROCESS=1`); run it from your own terminal. That check is a tripwire, not a boundary: see [limitations](../../security/controls/share-links.md#limitations). If the URL is loopback, the command also prints `Warning: Opens only on this machine — set webBaseUrl and expose the port to share`.

5. List and revoke. In the web UI, open Settings → Security & access → **Shared links** (it is in the settings rail and the settings search). Each row shows the title, a short reference, the expiry, the view count and when it was last viewed, with a **Revoke** button. Revoke opens an inline confirm: choose **Revoke link** to delete the copy, or **Keep** to cancel. Links stay listed and revocable while sharing is off. From the CLI:

   ```bash
   ethos sessions share list
   ethos sessions share revoke <prefix>
   ```

   Neither shows the full URL; only the creator saw it. Revoking deletes the stored copy, and the URL answers 404 from then on. `<prefix>` needs at least 4 characters and must match one active link. Deleting a session revokes its links.

## What the reader sees

A single page with the title, the personality, the creation and expiry times, and the user and assistant messages as plain text. Tool names appear as small chips if you included them. The page loads no scripts, fonts, images or links, so it renders in the reader's system font and follows their light or dark setting. It tells search engines not to index it and sends no referrer.

## What is never included

| Never in the copy | Why it matters |
|---|---|
| System prompt and system rows | Your personality's instructions stay private. |
| Tool inputs and outputs | Tool output is where secrets and private data concentrate. Only names, if you opt in. |
| Attachments and inline file text | Only the text you typed is kept. Attachment notes and the text of uploaded files are stripped. |
| Memory writes and cards | Only user and assistant message text survives. |

Redaction is pattern-based, so a message you typed or the agent wrote can still carry a secret it does not recognise. See [what share links do not protect against](../../security/controls/share-links.md#limitations).

## Verify

1. Open the URL in a private browser window. Expect the conversation, with no sign-in prompt.
2. Run `ethos sessions share revoke <prefix>`, then reload. Expect the same "Not found" page you get for any wrong link.

## Troubleshoot

| Symptom | Cause and fix |
|---|---|
| `Share links are turned off.` (CLI) | `shareLinks.enabled` is not `true`. Set it. Existing links return 404 while it is off. |
| `This is a shared-room or incognito session` (CLI) | Rooms with several people and incognito sessions cannot be shared. Share a private chat instead. |
| `Personality "<id>" is excluded from share links.` (CLI) | Remove it from `shareLinks.excludePersonalities`. |
| `The session has no user or assistant text to share.` (CLI) | The session has only attachments or tool activity. Check the id with `ethos sessions list`. |
| `...larger than the ... byte share limit.` (CLI) | The redacted copy is over 2 MiB. Share a shorter session. |
| **Share…** is missing from the menus | Sharing is off, the settings are still loading, or the session is incognito. Set `shareLinks.enabled: true`, then reload the page; the UI can lag up to about 30 seconds. |
| "Share links are off." (web UI) | `shareLinks.enabled` is not `true`. Set it in `~/.ethos/config.yaml`. |
| "This session can't be shared." (web UI) | Rooms with several people and incognito sessions cannot be shared. |
| "Sharing is off for" a personality (web UI) | Remove it from `shareLinks.excludePersonalities`. |
| "This conversation is too large to share." (web UI) | The redacted copy is over the 2 MiB limit. Turn off **Include tool names** or share a shorter session. |
| "Nothing to share." (web UI) | No user or assistant message is left after redaction. |
| "This session no longer exists." (web UI) | It was deleted or never saved. Close the dialog and refresh the list. |
| Teammate gets "Not found" | The link expired, was revoked, or was mistyped. All three look identical on purpose. A 429 means too many requests: wait 10 minutes. |
| Teammate cannot connect | The link is loopback or the port is not exposed. Fix `webBaseUrl` and the network, then create a new link. |
