---
title: "Consume attachments in a tool"
description: "Declare the attachments capability and use ctx.attachments to read user-supplied files in your tool."
kind: how-to
audience: developer
slug: consume-attachments-in-a-tool
time: "10 min"
updated: 2026-05-14
---

## Task

Build a [tool](../../getting-started/glossary.md#tool) that reads files attached by the user (images, PDFs, documents) using the capability framework. The framework filters attachments by declared kinds and resolves cached `file://` URLs to local paths at call time.

## Result

A tool whose attachment access is declared in `capabilities.attachments` and routed through `ctx.attachments`. The [personality](../../getting-started/glossary.md#personality) controls which tools see attachments; the capability resolver filters the list to match the declared kinds. Attempts to open a ref not present in the filtered list throw an error the LLM can act on.

## Prereqs

- `@ethosagent/types` (for `Tool`, `ToolResult`, `ToolCapabilities`, `ScopedAttachments`).
- A platform adapter that populates `InboundMessage.attachments` (Telegram and Slack do this today).
- An `AttachmentCache` wired into `CapabilityBackends` (production wiring handles this).

## Steps

### 1. Declare the capability

Add `capabilities.attachments` to your tool definition. The `kinds` field controls which attachment types the tool receives:

```ts
capabilities: {
  attachments: { kinds: ['image'] },       // images only
}
```

```ts
capabilities: {
  attachments: { kinds: ['file'] },        // documents only (PDFs, text, etc.)
}
```

```ts
capabilities: {
  attachments: { kinds: ['image', 'file'] }, // both
}
```

```ts
capabilities: {
  attachments: { kinds: '*' },             // all current and future types
}
```

The capability resolver calls `allAttachments.filter(a => kinds.includes(a.type))` when `kinds` is an array. When `kinds` is `'*'`, the tool sees every attachment on the turn.

### 2. Use ctx.attachments in execute

The framework provides `ctx.attachments: ScopedAttachments` when the tool declares the capability and the turn carries attachments. The interface has three methods:

| Method | Signature | Purpose |
|---|---|---|
| `list()` | `() => Attachment[]` | Return all attachments matching the declared kinds. |
| `open(att)` | `(att: Attachment) => Promise<{ path: string }>` | Resolve a known `Attachment` object to a local file path. |
| `openByRef(ref)` | `(ref: string) => Promise<{ path: string }>` | Look up an attachment by its opaque `ref` string and resolve to a local path. |

### 3. Write a minimal tool

This tool reads an attached file by ref and returns its first 100 characters:

```ts title="src/preview-attachment.ts"
import type { Tool, ToolResult } from '@ethosagent/types';
import { readFile } from 'node:fs/promises';

export const previewAttachmentTool: Tool = {
  name: 'preview_attachment',
  description: 'Read the first 100 characters of an attached file.',
  toolset: 'file',
  capabilities: {
    attachments: { kinds: ['file'] },
  },
  schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'Opaque attachment reference (e.g. att-0) from the <attachments> block.',
      },
    },
    required: ['ref'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { ref } = args as { ref: string };

    if (!ctx.attachments) {
      return { ok: false, error: 'No attachments available for this turn.', code: 'not_available' };
    }

    try {
      const { path } = await ctx.attachments.openByRef(ref);
      const content = await readFile(path, 'utf-8');
      return { ok: true, value: content.slice(0, 100) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};
```

### 4. Understand how list() filtering works

`list()` returns only attachments whose `type` matches the declared `kinds`. If the user sends a photo and a PDF in one message, and the tool declares `kinds: ['image']`, `list()` returns only the photo. The PDF is invisible to this tool -- a different tool declaring `kinds: ['file']` would see it.

Use `list()` when the tool operates on all available attachments without the LLM specifying a ref:

```ts
const images = ctx.attachments.list();
if (images.length === 0) {
  return { ok: false, error: 'No images attached.', code: 'input_invalid' };
}
```

### 5. Understand how open() resolves URLs

`open(att)` resolves `file://` URLs through the `AttachmentCache`. The cache stores downloaded files under `~/.ethos/cache/attachments/` keyed by an opaque hash of the session key, message id, and filename. The returned `path` is an absolute filesystem path you can read with `node:fs`.

Only `file://` URLs are supported. Other URL schemes throw `'Unsupported URL scheme in attachment: <url>'`.

### 6. Handle errors

Two error messages come from `ScopedAttachmentsImpl`:

| Error message | Cause | Fix |
|---|---|---|
| `No attachment with ref "<ref>"` | The ref does not match any attachment in the filtered list. | Check that the ref from the `<attachments>` block is passed verbatim. |
| `Unsupported URL scheme in attachment: <url>` | The attachment URL is not a `file://` URL. | This should not happen with built-in adapters. If you see it, the adapter is not caching files locally. |

A third error is a guard in your own code:

| Error message | Cause | Fix |
|---|---|---|
| `ctx.attachments` is undefined | The tool declared `attachments` but no `AttachmentCache` was wired, or the turn has no attachments. | Check that `CapabilityBackends.attachmentCache` is provided. In tests, pass an `InMemoryAttachmentCache`. |

### 7. Combine with existing file_path arguments

Existing tools like `read_file` and `vision_analyze` accept both `ref` and `file_path`. When `ref` is present, the tool resolves it to a path via `ctx.attachments.openByRef(ref)` and uses that path for the rest of the execution. When `ref` is absent, the tool falls back to the explicit `file_path` argument.

This pattern preserves backward compatibility: direct paths still work for files already on disk. The `ref` argument adds support for user-attached files without changing the tool's core logic.

## Verify

Write a test that confirms the tool reads an attachment:

```ts
import { ScopedAttachmentsImpl } from '@ethosagent/core/scoped';
import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';

const cache = new InMemoryAttachmentCache();
const url = await cache.write(new TextEncoder().encode('hello world'), {
  sessionKey: 'test', messageId: 'm1', filename: 'doc.txt', mime: 'text/plain',
});

const attachments = new ScopedAttachmentsImpl(
  [{ type: 'file', ref: 'att-0', url, mimeType: 'text/plain', filename: 'doc.txt' }],
  ['file'],
  cache,
);

const { path } = await attachments.openByRef('att-0');
expect(path).toBeTruthy();
```

Run `pnpm check` to confirm the tool passes typecheck, lint, and tests.

## Troubleshoot

**`ctx.attachments` is undefined.** -- The tool declared `attachments` but no `AttachmentCache` was wired into `CapabilityBackends`, or the current turn has no attachments from the user. In tests, provide an `InMemoryAttachmentCache` and populate `backends.inboundAttachments`.

**`No attachment with ref "att-2"`.** -- The ref does not exist in the filtered attachment list. The user may have attached fewer files than expected, or the tool's `kinds` filter excluded the file's type.

**`Unsupported URL scheme`.** -- The attachment URL is not `file://`. Built-in adapters (Telegram, Slack) always cache to local files. If you see this error, a custom adapter is not using the `AttachmentCache.write()` path.

**Tool sees zero attachments but user sent a file.** -- Check the tool's `kinds` declaration. A tool declaring `kinds: ['image']` does not see documents (PDFs, text files). Widen to `['image', 'file']` or `'*'`.
