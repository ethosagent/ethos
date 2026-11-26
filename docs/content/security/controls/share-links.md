---
title: "Security controls: shared session links"
description: "What a public share link exposes, the controls that bound it, and the limitations the operator still owns: redaction gaps, proxy logs and the rate limit."
kind: reference
audience: shared
updated: 2026-11-26
---

## Synopsis {#synopsis}

A shared session link publishes a redacted, frozen, read-only copy of one chat at an unguessable URL that needs no sign-in. This page lists the threats in user terms, the control for each and the test that pins it, then the limitations. Part of the [Security controls](../controls.md); the task is in [Share a session](../../using/how-to/share-a-session.md).

## Threat model {#threat-model}

The feature is off by default (`shareLinks.enabled`). When on, anyone who can reach your Ethos web port and holds the URL can read the copy. Ethos uploads nothing to a third party. The risks are a guessed or leaked URL, a secret inside the copy, and an agent or API key that publishes on its own.

| Threat | Control | Pinned by |
|---|---|---|
| Someone guesses a URL | The token is 32 random bytes (43 base64url characters). Only its SHA-256 is stored, so a copied database holds no live URL. | `generates a 32-byte base64url token (43 chars)` and `stores the sha256 hash, never the token, in any column` in `extensions/share-links/src/__tests__/share-link-store.test.ts` |
| Probing tells a revoked link from a wrong one | Every miss (bad shape, unknown, revoked, expired, feature off, other path or method) returns one identical 404. | `uniform 404` in `apps/web-api/src/__tests__/routes/share-route.test.ts` |
| Brute force or scraping | 30 requests per client, one more every 2 seconds, then a 10 minute lockout. The Shared links list in Settings → Security & access and `ethos sessions share list` show view counts. | `rate limit: 30 requests pass, the 31st is 429 with Retry-After, and a hit link is locked out too` in `share-route.test.ts` |
| A secret or personal data in the text | Every message, title and tool name passes `redactString`; personal data (email, phone, card, SSN, IBAN) is also redacted unless you opt out. See limitation 1. | `redacts seeded secrets in text and title`, `pii default on; kept when options.pii === false` and `still redacts secrets when pii is false` in `packages/wiring/src/__tests__/share-snapshot.test.ts` |
| Tool output, files or the system prompt leak | Only user and assistant text is copied. Tool inputs and outputs, attachment notes, inline file text and system rows never enter the copy. | `keeps only user, user_steer (as user) and assistant rows`, `never carries tool inputs or outputs, with or without tool names`, `never copies attachment annotations, inline file text or error lines (D5)` and `never copies tool_use payloads: toolCalls input stays out of the snapshot` in `share-snapshot.test.ts` |
| Other people's words are published | Shared-room and incognito sessions are refused, as are sessions of `shareLinks.excludePersonalities`. | `shared_session for a shared room`, `shared_session for an incognito session` and `excluded_personality` in `packages/wiring/src/__tests__/share-publish.test.ts` |
| Script injection through the transcript | Text is HTML-escaped and shown as plain text. The page has no script, and its CSP is `default-src 'none'` plus `sandbox`. | `renders the XSS payload and "'&<> inert` and `headers: exact CSP with a fresh nonce matching the <style>, robots, referrer, cache` in `share-route.test.ts` |
| Cookie or session abuse from the page | The page reads and sets no cookie. | `no cookie: no set-cookie on 200 or 404, and verifyCookie is never reached` in `share-route.test.ts` |
| A link keeps working after revoke or expiry | Revoke deletes the stored copy in the same transaction that writes the audit event; an expired row is never served; the database runs `synchronous = FULL` so a power cut cannot undo a revoke. | `revoke purges the snapshot and appends a revoked event in one transaction`, `misses an expired row, including at the exact expiry instant` and `stays at synchronous = FULL in WAL mode` in `share-link-store.test.ts` |
| An old copy lingers on disk | Expired copies are deleted at start and then hourly. Deleting a session in the web UI or CLI revokes its links first. Every other deletion path (retention prune, desktop, a direct database edit) is caught by the hourly orphan sweep, which revokes links whose session no longer exists (limitation 8). | `purges on start, then every hour, and stop clears the timer` and `revokes orphans (links whose session no longer exists) on start and hourly, as system` in `apps/web-api/src/features/share/__tests__/share-purge.test.ts`; `revokes live links whose session no longer exists, as a system revoked event, and no others` in `share-link-store.test.ts`; `revokes the deleted session’s live links as the admin, and only those` in `apps/web-api/src/__tests__/services/sessions-delete-shares.test.ts` |
| A bearer API key or a prompt-injected agent publishes a link | Creating, listing and revoking in the web API is cookie-only: a key gets 403 on every `shares` procedure, and no agent tool creates links. Cross-site requests meet the same CSRF check as the rest of `/rpc`. `ethos sessions share <id>` refuses to create when `ETHOS_TOOL_PROCESS=1`, the marker on a process an agent's tool started (list and revoke still work). That CLI check is a tripwire, not a boundary (limitation 4). | `rejects a bearer key on /rpc/shares/%s with FORBIDDEN` (hand-built app) and `POST /rpc/shares/%s with a bearer key is 403` (real `createWebApi`) in `apps/web-api/src/__tests__/middleware/apikeys-auth-bypass.test.ts`; `csrf on shares.create and shares.revoke` in `apps/web-api/src/__tests__/middleware/csrf.test.ts`; `D12: create refuses inside a tool process (ETHOS_TOOL_PROCESS=1) and stores nothing` in `apps/ethos/src/commands/__tests__/sessions-share.test.ts` |
| The agent's file tools read or write the link database | `share-links.db` and its WAL files are denied to file tools and write-blocked. | `write-blocks share-links.db and its WAL sidecars` in `extensions/tools-file/src/__tests__/blocked-paths.test.ts`; the deny list in `packages/storage-fs/src/__tests__/state-dir-deny.test.ts` |
| A backup restore revives public links | `share-links.db` is never backed up. | `always excludes the transient stores and the sensitive paths` in `packages/wiring/src/backup/__tests__/scopes.test.ts` |
| A forged Host header poisons the printed URL | The base is `webBaseUrl`, else the bind address, never the request's Host. | `url base` in `apps/web-api/src/__tests__/services/share-service.test.ts` and `resolveShareBaseUrl` in `share-publish.test.ts` |
| Search engines index a link, or a click leaks it | `x-robots-tag: noindex, nofollow, noarchive`, a robots meta tag, `referrer-policy: no-referrer`, `cache-control: no-store`, and no outbound links. | `headers: exact CSP ...` in `share-route.test.ts` |
| Too large a copy | A redacted copy over 2 MiB is refused with the limit named. | `refuses a snapshot over 2 MB with a typed error naming the limit` in `share-link-store.test.ts`; `too_large names the limit and stores nothing` in `share-publish.test.ts` |

## Limitations {#limitations}

No test pins these; they are what the operator owns.

1. **Redaction is pattern-based and can miss secrets.** A credential shape outside the redactor's roster, a password in prose or a private detail the agent repeated ships as written. The web UI's preview is the only guard, so read it. The CLI has no preview.
2. **The token is in the URL path, so proxy logs hold live links.** Ethos writes no access log. Its request counter keeps the method and status only (`recordHttpRequest`, `apps/web-api/src/routes/index.ts`), and an uncaught error logs the request id and the error, not the URL (`errorHandler`, `apps/web-api/src/middleware/error-envelope.ts`). A reverse proxy or ingress usually logs the path, so anyone with its access logs holds every live link until it expires or is revoked. Shorten expiries, restrict who reads those logs, or turn off path logging for `/share/`.
3. **The rate limit is in memory and per process.** A restart resets it, and two Ethos processes keep separate counts. The bucket key is the connecting address. Behind a reverse proxy that address is the proxy's, so without `ETHOS_TRUST_PROXY=1` every reader shares one bucket and 30 quick reads lock everyone out for 10 minutes. With it set, Ethos keys on the first `X-Forwarded-For` entry (else `X-Real-IP`), so the proxy must overwrite those headers: a client that can set them mints a fresh bucket per request. The Helm chart sets the variable when `ingress.enabled` is true (`rateLimitMiddleware` and `clientKeyOf` in `apps/web-api/src/middleware/rate-limit.ts`).
4. **A shell tool on local execution can still publish.** The deny lists cover file tools only. A personality with a shell that runs on the host can edit `share-links.db` directly, or run `ethos sessions share` with `ETHOS_TOOL_PROCESS` unset (`env -u ETHOS_TOOL_PROCESS`). The CLI's refusal under `ETHOS_TOOL_PROCESS=1` is a tripwire that catches the plain case, not a boundary; it is pinned by `D12: create refuses inside a tool process (ETHOS_TOOL_PROCESS=1) and stores nothing` in `apps/ethos/src/commands/__tests__/sessions-share.test.ts`. Keep shell tools sandboxed, as in the [security boundary](../security-boundary.md).
5. **The page is plain text.** Code blocks and tables lose their formatting. Nothing is rendered as markdown, so nothing can run.
6. **Anyone with the URL can read it, and can forward it.** There are no per-reader accounts or passwords. Use short expiries and revoke when done.
7. **A link made on a loopback address opens only on your machine.** The web UI and the CLI warn about this; the fix is `webBaseUrl` and an exposed port. A wildcard bind (`0.0.0.0`, `::`) prints as `localhost` with the same warning, and all of `127.0.0.0/8` counts as loopback (`resolveShareBaseUrl` cases in `share-publish.test.ts`).
8. **A link to a deleted session can stay readable for up to one hour.** Deleting through the web UI or `ethos sessions delete` revokes at once. Any other path (the retention prune, the desktop app, editing `sessions.db`) is caught by the hourly sweep, so the link lives until the next sweep, at most an hour, and then shows as revoked by `system`. A sweep that cannot read the session store revokes nothing and logs `share link purge failed`.
9. **Chat and mail unfurlers count as views and show the title.** Slack, Teams and similar services fetch a pasted URL with GET to build a preview, so each paste adds views to the count and the preview shows the redacted title. A HEAD request is not counted (`HEAD serves the page headers but does not count a view; GET still does` in `share-route.test.ts`), but a GET unfurl cannot be told from a reader.

## Source {#source}

| Layer | Source |
|---|---|
| Store | [`extensions/share-links/src/`](https://github.com/ethosagent/ethos/tree/main/extensions/share-links/src/) |
| Snapshot and refusals | [`packages/wiring/src/share-snapshot.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/share-snapshot.ts), [`packages/wiring/src/share-publish.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/share-publish.ts) |
| Public page | [`apps/web-api/src/routes/share.ts`](https://github.com/ethosagent/ethos/blob/main/apps/web-api/src/routes/share.ts), [`apps/web-api/src/features/share/`](https://github.com/ethosagent/ethos/tree/main/apps/web-api/src/features/share/) |
| Config | [`packages/config/src/builders/share-links.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/builders/share-links.ts) |

## Examples {#examples}

Switch every link off at once during an incident, with no restart:

```yaml
shareLinks.enabled: false
```

Every `/share/<token>` URL answers 404 from the next request; turning it back on restores links that have not expired.

## See also {#see-also}

- [Share a session as a read-only link](../../using/how-to/share-a-session.md): create, list and revoke.
- [config.yaml: shareLinks](../../using/reference/config-yaml/operations.md#share-links): the two keys.
- [Security controls: injection, watcher and redaction](injection-watcher-redaction.md#credential-redaction): the redactor behind the copy.
- [What does Ethos guarantee, and what is outside its security boundary?](../security-boundary.md)
