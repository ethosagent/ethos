---
title: "config.yaml: email and web server keys"
description: "config.yaml email channel and web server keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys for the email channel and the web server. Part of the [config.yaml reference](../config-yaml.md).

## emailImapHost {#email-imap-host}

Type: string · Default: unset

IMAP server hostname for the email gateway. The email block requires all six of `emailImapHost`, `emailImapPort`, `emailUser`, `emailPassword`, `emailSmtpHost`, `emailSmtpPort` to bind.

```yaml
emailImapHost: imap.gmail.com
emailImapPort: 993
emailUser: you@example.com
emailPassword: ...
emailSmtpHost: smtp.gmail.com
emailSmtpPort: 587
```

## emailImapPort {#email-imap-port}

Type: integer · Default: unset

IMAP server port. Conventional values: `993` (TLS), `143` (STARTTLS).

## emailUser {#email-user}

Type: string · Default: unset

Mailbox username — typically the full email address.

## emailPassword {#email-password}

Type: string · Default: unset

Mailbox password. Use an app-specific password where the provider supports it (Gmail, Fastmail).

## emailSmtpHost {#email-smtp-host}

Type: string · Default: unset

SMTP server hostname for outbound mail.

## emailSmtpPort {#email-smtp-port}

Type: integer · Default: unset

SMTP server port. Conventional values: `587` (STARTTLS), `465` (TLS).

## emailTrustedAuthservId {#email-trusted-authserv-id}

Type: string · Default: unset

The authserv-id your mailbox's own receiving mail server stamps on incoming mail: the first token of its `Authentication-Results` header (RFC 8601). The email gateway treats a sender's `From:` address as their identity only when the topmost `Authentication-Results` header carrying this id reports `dmarc=pass` with `header.from` equal to the `From:` domain, or `dkim=pass` with `header.d` equal to, or a parent of, that domain. Every other header is ignored. Enforced by `resolveEmailSender` in [`extensions/platform-email/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/platform-email/src/index.ts).

```yaml
emailTrustedAuthservId: mx.google.com
```

Notes:

- **Unset means every sender is unverified.** An unverified sender gets the user id `email-unverified:<sha256 of the lowercased address>` instead of their address. That id is stable per address and cannot equal a verified user's id, so it never inherits that user's memory, `channel_filter` owner status or approvals. The message reaches the personality with a one-line `[unverified sender]` notice in front of it, and runs in its own session rather than the verified sender's. Replies still go to the `From:` address.
- To find the value, open the raw source of any mail this account received and read the first word after `Authentication-Results:`. On Gmail that is `mx.google.com`. The comparison ignores case.
- `ethos gateway start` and `ethos boot` record one warn-level observability event (`email.sender_auth_unconfigured`) and print one console line at startup when email is configured without this key.
- A header the parser cannot read, found above the trusted one, makes the sender unverified. So do more than one `From:` header, and an explicit non-pass `dmarc` result, even when `dkim` passed.

## web.host, web.port, web.corsOrigins {#web-server}

Type: dotted group · Default: per-field below

Bind address, port, and CORS origins for the `ethos serve` web API — the process that mounts `/v1/*` and `/rpc/*`.

| Field | Type | Default | Description |
|---|---|---|---|
| `web.host` | string | `127.0.0.1` | Bind address. Precedence: `--web-host` CLI flag > `ETHOS_WEB_HOST` env var > this key > default. |
| `web.port` | integer | `3000` | Listen port. Precedence: `--web-port` CLI flag > `ETHOS_WEB_PORT` env var > this key > default. |
| `web.corsOrigins` | string | unset (no CORS) | Comma-separated origins (or `*`) allowed to call `/v1/*` directly from a browser. No CLI flag exists for this one. Precedence: `ETHOS_API_CORS_ORIGINS` env var > this key > default (unset). |

```yaml
web.host: 0.0.0.0
web.port: 3000
web.corsOrigins: "https://chat.example.com"
```

Notes:

- See [Serve Ethos as an OpenAI-compatible backend](../../../building/how-to/openai-server-chat.md#1-boot-the-server) for these keys in practice, including the CORS caveat for server-side clients.
- `ETHOS_WEB_TOKEN` (env var only, no config key) supplies the web UI's bootstrap token instead of the generated `<dataDir>/web-token` file. The value must be at least 24 characters — a shorter one stops the boot with an error suggesting `openssl rand -hex 32`. While it is set, `ethos serve` does not print the sign-in URL; the operator already holds the token.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
