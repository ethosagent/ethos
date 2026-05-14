---
title: "Receive files via Slack"
description: "Configure your Slack bot to ingest files from messages and threads."
kind: how-to
audience: operator
slug: receive-files-via-slack
time: "5 min"
updated: 2026-05-14
---

## Task

Accept files attached to Slack messages so the agent can read, analyze, or process them.

## Result

Users attach a file in a thread or DM, @mention the bot (or post in a channel where the bot responds), and the agent sees an `<attachments>` block. The agent calls tools like `vision_analyze` or `read_file` to work with the file.

## Prereqs

- A working Slack bot connected to Ethos -- see [the Slack quickstart](../../../extensions/platform-slack/README.md#quickstart--ten-minutes-to-your-first-reply).
- At least one personality with `vision_analyze` or `read_file` in its `toolset.yaml`.

## Steps

### 1. Verify the `files:read` scope

The Slack adapter needs the `files:read` bot token scope to download files from messages. If you created your app from the manifest in the Slack adapter quickstart, this scope is already included. If you are upgrading from a pre-attachment build, add the scope:

1. Open the [Slack API dashboard](https://api.slack.com/apps).
2. Select your app.
3. Go to **OAuth & Permissions** > **Scopes** > **Bot Token Scopes**.
4. Add `files:read`.
5. **Reinstall to Workspace** to apply the new scope.

Without `files:read`, the adapter cannot download files from `url_private_download` and file attachments are silently skipped.

### 2. Verify the personality has attachment-capable tools

Check your personality's `toolset.yaml`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- read_file        # reads attached documents via ref argument
- vision_analyze   # analyzes attached images via ref argument
```

Without these tools (or custom tools declaring `capabilities.attachments`), the agent sees the `<attachments>` block but cannot open the files.

### 3. Send a file and observe

1. Open a DM with the bot, or go to a channel where the bot is active.
2. Attach a file (click the `+` button or drag and drop).
3. Add a message like "Summarize this document" or send the file without text.
4. @mention the bot if the channel mode requires it.
5. The agent sees the attachment metadata and calls the appropriate tool.

When no text accompanies the file, the adapter surfaces `(file attachment)` as the message text so the agent has context.

## Supported types

| Category | Extensions | Attachment type |
|---|---|---|
| Images | jpg, jpeg, png, gif, webp, heic, bmp, svg, tiff | `image` |
| Documents | pdf, txt, csv, json, yaml, md, and all other non-skipped extensions | `file` |

## Not supported yet

Audio (mp3, wav, ogg, flac, aac, m4a) and video (mp4, mov, webm, avi, mkv) files are intentionally skipped. These types are deferred until transcription and media analysis tools ship.

## Limits

- **Size cap: 25 MB per file.** Files exceeding this limit are silently skipped.
- **Required scope: `files:read`.** Without this scope, the adapter cannot fetch file bytes from Slack's API.
- **No additional bot permissions needed.** The standard scopes from the app manifest are sufficient.

## How it works

1. User attaches a file to a message and @mentions the bot (or the channel mode allows the message through).
2. Slack delivers the message as a `file_share` subtype with a `files` array.
3. The adapter classifies each file by extension: image extensions become `type: 'image'`, everything else becomes `type: 'file'`, and audio/video extensions are skipped.
4. The adapter fetches each file from `url_private_download` with the bot token in the `Authorization` header.
5. The file is written to the `AttachmentCache` at `~/.ethos/cache/attachments/`.
6. The `InboundMessage` carries an `attachments` array with `type`, `ref`, `url` (a `file://` path), `mimeType`, and optional `filename` and `sizeBytes`.
7. `buildAttachmentAnnotation()` prepends an `<attachments>` XML block to the user's text.
8. The LLM sees the block and can call `vision_analyze` or `read_file` with the `ref` argument (e.g. `ref: "att-0"`).

## Troubleshoot

**Agent ignores the attached file.** -- Check that the personality's `toolset.yaml` includes `vision_analyze` (for images) or `read_file` (for documents). Without attachment-capable tools, the agent cannot open the file.

**Files are silently skipped.** -- Verify the `files:read` scope is present. Go to **OAuth & Permissions** in the Slack app dashboard and confirm it is listed. Reinstall if you just added it.

**Bot does not respond to file-only messages.** -- Check the channel mode. In `mention_only` mode (the default), you must @mention the bot even when attaching a file. DMs always respond regardless of mode.

**"(file attachment)" appears but no tool call.** -- The agent sees the attachment metadata but has no tool to process it. Add `read_file` or `vision_analyze` to the personality's toolset.
