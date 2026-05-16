---
title: "Why are attachments a capability?"
description: "The architectural insight behind treating user-attached files as a declared capability rather than a per-adapter feature."
kind: explanation
audience: developer
slug: why-attachments-are-a-capability
updated: 2026-05-14
---

## Context

Users send files to agents -- photos in Telegram, PDFs in Slack, documents dragged into a chat. Before attachments became a capability, each adapter handled file ingestion as a one-off. The Telegram adapter downloaded photos via `getFile`, the Slack adapter fetched `url_private_download`, and each wired its own storage path. The gateway passed the raw platform data through. Tools could not declare "I need images" in a way the framework could enforce, and file data either leaked into every tool's context or disappeared at the adapter boundary.

This page explains why the codebase treats attachments as the sixth capability category -- alongside `network`, `secrets`, `storage`, `fs_reach`, and `process` -- instead of leaving file ingestion as adapter-specific plumbing.

## Discussion

### The problem: five different shapes for the same thing

Without a capability, each adapter invents its own attachment shape. Telegram produces a `file_id` and a Bot API download URL. Slack produces a `url_private_download` with a bearer token. Discord produces a CDN URL. Email produces a MIME part. The gateway has no common contract to thread these through, so it either drops them or passes opaque platform data the tool cannot use without knowing which adapter sent it.

A tool that wants to read an attached image must know: did this come from Telegram (call `getFile`, download from Bot API, parse the JPEG)? Or Slack (add the `Authorization: Bearer` header, fetch from `url_private_download`)? Or email (decode the MIME base64 body)? The tool becomes a platform dispatcher, and every new adapter requires a code change in every attachment-consuming tool.

### The fix: one shape in, one declaration out

The attachment capability standardises both sides of the contract:

**Adapter side.** Every adapter that ingests files produces the same `Attachment` shape: `{ type, ref, url, mimeType, filename?, sizeBytes? }`. The adapter downloads the file, writes it to the `AttachmentCache`, and gets back a `file://` URL. The `InboundMessage.attachments` array carries these shapes into the gateway. The adapter does not decide which tools see the files -- it produces data and moves on.

**Tool side.** A tool declares `capabilities.attachments: { kinds: ['image'] }` (or `['file']` or `'*'`). The capability resolver filters the turn's attachments to match the declared kinds and provides `ctx.attachments` with `list()`, `open()`, and `openByRef()`. The tool never imports a platform SDK, never constructs an auth header, never parses a MIME boundary. It calls `openByRef('att-0')` and gets a local path.

**Agent side.** `buildAttachmentAnnotation()` produces an `<attachments>` XML block prepended to the user's text so the LLM sees what files are available. The LLM references attachments by their opaque `ref` values (e.g. `att-0`, `att-1`) when calling tools.

### Per-turn reach extension

A naive approach would cache every attachment and give every tool permanent read access to the cache directory. That fails the capability model's principle: a tool should access only what the current turn provides.

The resolver implements per-turn reach extension. When attachments are present on a turn, the resolver computes the cache directories those files live in and merges them into the tool's `ScopedFs` read paths -- but only for that turn's execution. The next turn with different attachments produces different read paths. A tool that declares `fs_reach` gets the union of its declared paths and the attachment directories; a tool that does not declare `fs_reach` but does declare `attachments` gets a read-only `ScopedFs` scoped to just the attachment directories.

This prevents "agent can read all cached files forever." The reach is per-turn, scoped to the session, and bounded by what the user sent in this message.

### The ref opacity discipline

Attachment refs (`att-0`, `att-1`) are opaque identifiers. The LLM sees them in the `<attachments>` annotation, passes them to tools, and the tools call `openByRef(ref)` to resolve them. The ref does not encode the file path, the cache location, or any platform-specific identifier.

This is the same pattern as `MemoryContext.scopeId` -- an opaque token that the framework resolves internally. The tool does not need to know where the file lives, how it was downloaded, or which platform sent it. The ref is a handle; the framework does the rest.

The opacity also protects against prompt injection. A malicious attachment filename cannot trick the LLM into calling `openByRef('/etc/passwd')` -- the ref is a short, framework-assigned identifier, not a user-controlled path.

### Multi-tenant-ready cache

`AttachmentCache.write()` takes a `sessionKey` parameter. The cache uses an opaque hash of the session key to namespace files on disk. Different sessions (different users, different bots, different platforms) write to different directories under `~/.ethos/cache/attachments/`. No session can read another session's cached files through the framework.

`AttachmentCache.clear(sessionKey)` removes all cached files for a session. `pruneOlderThan(ms)` sweeps stale entries across all sessions, used by the gateway's periodic cleanup. The cache is designed for multi-tenant deployments where a single gateway serves multiple bots and multiple users.

### Cost of a new adapter

Adding attachment support to a new adapter requires approximately 30 lines of code:

1. Detect which message fields carry files (platform-specific).
2. Download the file bytes.
3. Call `cache.write(bytes, { sessionKey, messageId, filename, mime })` to get a `file://` URL.
4. Push an `Attachment` object onto `InboundMessage.attachments`.

The adapter does not register tools, does not modify the capability resolver, and does not touch the annotation builder. The Telegram adapter's `downloadAndAttach()` method and the Slack adapter's `extractFileAttachments()` function each follow this pattern.

### What the six categories look like now

| Category | Declaration shape | What it gates |
|---|---|---|
| `network` | `{ allowedHosts: string[] }` | Which hosts the tool may fetch |
| `secrets` | `SecretRef[]` | Which secret names the tool may read |
| `storage` | `{ scope: StorageScope; kind: 'kv' }` | Key-value storage with a scoped lifecycle |
| `fs_reach` | `{ read?: string[]; write?: string[] }` | Filesystem paths the tool may read/write |
| `process` | `{ allowedBinaries: string[] }` | Which binaries the tool may spawn |
| `attachments` | `{ kinds: ('image' \| 'file')[] \| '*' }` | Which user-attached file types the tool may read |

Attachments follow the same lifecycle as every other capability: declared on the tool, validated at registration, resolved at call time, and scoped to the current execution context.

## Trade-offs

**Adapters must cache locally.** Every adapter downloads the file and writes it to the `AttachmentCache` before the message reaches the agent. This adds latency (one download per file) and disk usage. The alternative -- passing URLs and downloading on demand inside the tool -- would require each tool to handle auth headers and network errors, which is exactly the fragmentation the capability eliminates.

**Only `file://` URLs are supported.** `open()` throws on non-`file://` schemes. A future extension could add `https://` resolution with auth header injection, but v1 keeps it simple: the adapter downloads, the cache stores, the tool reads locally.

**The `kinds` filter is coarse.** `'image'` and `'file'` are the only two types. A tool that wants only PDFs must declare `kinds: ['file']` and filter by `mimeType` in its own code. Adding finer-grained types (e.g. `'pdf'`, `'audio'`) is possible but deferred until a real consumer needs it.

## See also

- [Why declare capabilities instead of importing dependencies?](why-capabilities.md) -- the general capability framework this extends
- [Consume attachments in a tool](../how-to/consume-attachments-in-a-tool.md) -- step-by-step guide
- [Tool isolation model](tool-isolation-model.md) -- the enforcement points in detail
- [Tool capabilities reference](../reference/tool-capabilities.md) -- every type, interface, and error code
