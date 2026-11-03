---
title: "Browser tools: launch posture, profiles, bot walls and login"
description: "Browser tool profiles, bot walls, takeover and stored-login fill."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

How the browser launches, keeps state and hands control to a person. Part of the [Browser tools reference](../browser-tools.md).

## Launch posture {#launch-posture}

Everything about how a session launches is operator config under [`browser.*`](../../../using/reference/config-yaml.md#browser), resolved once at tool-construction time in [`launch-options.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/launch-options.ts) and applied to every session.

**Headed vs. headless.** `browser.headed` is three-state, not a boolean:

- `auto` — the default, and what an absent key means. Headed where this machine can put a window on a screen: always on macOS and Windows; on Linux/BSD only when `DISPLAY` or `WAYLAND_DISPLAY` is set. Headless otherwise.
- `true` — headed. On a machine with no display this does not fail; it falls back to headless, and the `browse_url` / `browser_navigate` result that opened the session carries `⚠ browser.headed: true, but this machine has no display (no DISPLAY or WAYLAND_DISPLAY) — running headless.` once.
- `false` — headless, unconditionally.

**This is a visible change on upgrade.** Earlier releases were always headless. A developer on macOS will now see a real Chromium window open on the first `browse_url`. Set `browser.headed: false` to keep the previous behaviour.

**Proxy.** `browser.proxy.server` routes every session through an upstream proxy and must carry an explicit scheme (`http`, `https`, `socks4`, `socks5`); a bare `host:port` is refused at boot rather than guessed at. Before you set it, read [the SSRF limit under a proxy](../../../security/controls.md#ssrf-browser-proxy) — it is a real gap, not a caveat.

**No stealth tier ships.** `browser.stealth.enabled` parses and is stored, and nothing reads it. There is no stealth engine, no fingerprint patching and no stealth-tier tool in this release; setting the key changes no behaviour.

## Persistent profiles {#profiles}

With `browser.profiles.enabled: true`, a session launches as a Playwright *persistent context* rooted at `~/.ethos/browser-profiles/<personality-id>/` instead of a throwaway one. Cookies, local storage and site data written there survive the session, the turn, `/new`, and a restart — a login the agent (or a human, during a takeover) completes once holds for every later session under that personality.

Profiles are **per personality**, which is the isolation boundary: two personalities never share a login, and a personality id that is not `[A-Za-z0-9_-]+` gets no profile at all rather than being allowed to name a directory. Profiles are **off unless the key is explicitly `true`** — an absent key is off.

A profile directory can only be open once. **Inside one Ethos process**, that is enforced by the per-profile mutex in [`sessions.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/sessions.ts) — `acquireProfileLock`. A second concurrent session for the same personality waits **15 seconds** for the first to finish, then gives up and launches an ordinary ephemeral context instead. That fallback is not silent — the `browse_url` / `browser_navigate` result that opened the session carries:

```text
⚠ Browser profile '<personality-id>' is in use by another session — this second session is not logged in.
```

Treat that warning as load-bearing. The second session works, and it is signed into nothing.

### Run one process per profile {#profiles-one-process}

**The mutex is process-local; the directory it guards is not.** `acquireProfileLock` is a promise chain held in one Node process's memory, while `~/.ethos/browser-profiles/<personality-id>/` is shared state on disk. A second Ethos process running the same personality — `ethos serve` beside `ethos gateway`, the desktop app beside a CLI chat, two daemons on one host — never sees the first process's lock. It does not wait 15 seconds, and it does not fall back to an ephemeral context.

What it meets instead is Chromium's own single-instance lock on the user data directory, one layer down and far less forgiving: `launchPersistentContext` fails, and the failure surfaces as a **failed** `browse_url` / `browser_navigate` — not as a warning on a working session. There is no cross-process lock behind the profile directory yet.

The failure is loud, not silent: Chromium refuses to open a directory another live Chromium holds, so what you lose is the tool call, not the login already stored in the profile. We have no evidence of profile corruption from a concurrent launch, and this page does not claim any.

Until a cross-process lock ships, pick one:

- **Run one Ethos process per personality profile. (Recommended)** The in-process mutex then covers every session that touches the directory, and the 15-second wait and ephemeral fallback above behave exactly as documented.
- **Set `browser.profiles.enabled: false` on the secondary process.** Its sessions are ephemeral and signed into nothing — the same posture as the in-process fallback, chosen deliberately rather than arrived at through a launch error.

## Bot walls {#bot-walls}

A bot wall answers a navigation with a real page — a 200, or a 403/429/503, with HTML and a title. Playwright reports success, and without a check the agent would read "Just a moment…" as the article it asked for. So `browse_url` and `browser_navigate` run [`detectBlock`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/block-detector.ts) over the response status, headers, title and rendered text.

A detected wall is a **failure**, not a success carrying a flag:

```text
Blocked by Cloudflare bot protection (HTTP 403) at https://example.com/article —
matched "just a moment". The page content was not read and no retry was
attempted. Escalate with browser_request_takeover to hand the live browser to
the user so they can clear the interstitial, then navigate again.
```

The result names the vendor when one is recognised, the status when one triggered it, and the exact marker that matched, so the call is checkable. Nothing is retried and nothing is escalated on the agent's behalf.

Two triggers, in order: a named vendor signature (Cloudflare, DataDome, PerimeterX, Akamai — by header or on-page phrase), or failing that a bare 403/429/503, which reports an unnamed wall.

**The signature list is deliberately narrow.** `server: cloudflare` and `server: AkamaiGHost` sit on a large fraction of the healthy web and are **not** treated as blocks; Cloudflare is matched on `cf-mitigated`, the header that means "this response *is* the wall", and Akamai on its deny-page reference block. A false positive tells the agent a page it can read is walled, which is worse than a miss — a miss is recoverable because the snapshot is right there.

The hint names an escalation tool only when this process actually registered one. In a deployment with no `ClarifyBridge` there is no `browser_request_takeover`, and the hint says so rather than naming a tool the agent would waste a turn calling.

## Human takeover {#takeover}

`browser_request_takeover({ reason, timeout_s? })` pauses the agent and hands the live browser session to a person — for a login, an MFA prompt, a consent screen, or an interstitial the agent cannot clear. It is registered only when wiring supplies a `ClarifyBridge`: a deployment with no interactive surface has nobody to hand a browser to.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `reason` | string | — | Required, non-empty. What the user needs to do, in one sentence — shown to them verbatim. An empty or missing value is `input_invalid`. |
| `timeout_s` | number | `900` (15 min) | How long to wait for the hand-back. Rounded and clamped to `1`–`86400`. |

The call blocks until the takeover settles. While it is pending:

- A headed session is brought to the front (`page.bringToFront()`) so the window the user is being asked to use is not behind everything else. A headless session has nothing to raise.
- **Every other browser tool refuses** with `not_available` and `A human has taken over this browser session — the agent cannot drive it until they hand it back.` The code is `not_available` rather than `execution_failed` on purpose: the tool is fine, the browser is simply not the agent's right now.
- The idle sweeper skips the session.

On a real hand-back the tool returns:

```json
{
  "handed_back": true,
  "outcome": "user",
  "url": "https://example.com/dashboard"
}
```

`handed_back` is true **only** when a person actually handed the session back (`outcome: "user"`). A cancelled takeover returns `handed_back: false` with `outcome: "cancel"` — reported as true, it would tell the agent the login it is about to depend on has happened. A timeout does not return at all: it is `execution_failed` with `No one took over the browser within <n>s. The page is unchanged; report the blockage.` A session closed mid-takeover is `execution_failed` too, with nothing handed back, and a deployment where no surface can carry the request fails with `not_available`. The lock is released on every one of those paths, in a `finally` — a lock leaked on any exit would wedge browsing for the rest of the process.

**What the human sees** depends on the surface. The web chat draws a panel with the URL, a countdown and a **Hand back** button, and disables the composer. Telegram, Slack, Discord and WhatsApp cannot host a browser, so they render one sentence pointing at the machine and the web chat:

```text
I'm stuck on a login at example.com — the browser window is open on the machine
running Ethos; open the web chat to hand back: https://ethos.example.com/chat
```

That link is `<webBaseUrl>/chat`, built from `webBaseUrl` (which resolves `ETHOS_PUBLIC_URL` first). It names the web app's permanent chat entry point rather than a per-session deep link, because a channel row's session id is a channel key (`telegram:12345`) that the web router would 404 on. With nothing configured the sentence degrades to naming the web chat without a link — no scheme, host or port is ever guessed.

A takeover hands over a live, logged-in session. See [the security note](../../../security/controls.md#browser-takeover-exposure) before granting this tool.

## Stored-login fill {#fill-credential}

`browser_fill_credential` fills a login the operator stored, by name. The model passes the credential name and element refs from the latest snapshot; the tool resolves the values itself after every check has passed. No argument carries a value, so `tool_start.args`, the persisted `tool_use` block and traces hold nothing secret.

| Argument | Type | Meaning |
|---|---|---|
| `credential` | string, required | Credential name. Letters, digits, `-`, `_` (`SECRET_NAME_RE`). |
| `username_ref` | string | `@eN` of the username field. |
| `password_ref` | string | `@eN` of the password field. Must be an `<input type="password">`. |
| `totp_ref` | string | `@eN` of the 2FA code field. The code is generated from the stored seed. |
| `submit` | boolean | Press Enter in the last filled field. Default `false`. |

At least one `*_ref` is required. On success the result is the post-fill snapshot plus `{"filled": [...], "origin": "..."}`.

**Vault layout.** A credential named `<name>` is four vault refs: `credentials/<name>/username`, `…/password`, `…/totp` (optional base32 seed or `otpauth://totp/` URI), and `…/policy`, JSON `{ "origins": [...], "personalities": [...], "unattended": false }`. Store them with `ethos secrets credential add <name> --origin <origin> --personality <id>` (values are prompted, the password and seed without echo) or in the web app under Settings › Security › logins. Edit grants with `ethos secrets credential grant|revoke <name> --personality <id> [--unattended]`.

**Checks, in order.** Each refusal is a fixed message that names neither the ref nor the value, and each call writes one `browser.credential_fill` event to observability, success or refusal, carrying names and origins only.

| Audit `code` | Refused when |
|---|---|
| `not_found` | The credential, a needed field or its policy is missing or unparseable, or a ref is not on the current page. A policy listing a non-https, non-loopback origin counts as unparseable. |
| `refused_personality` | The active personality is not in `policy.personalities`. An empty list is usable by nobody. The tool must also be in the personality's `toolset.yaml`. |
| `refused_unattended` | `policy.unattended` is false and the turn is a background job, or no clarify surface is registered for the turn's platform (`ClarifyBridge.canPresent`). |
| `refused_origin` | The top-level page's origin, or the origin of the frame owning any target field, is not exactly (`===` on `URL.origin`) one of `policy.origins`. `https:` only; `http:` is allowed for `localhost`, `127.0.0.1` and `[::1]`. |
| `refused_field_type` | `password_ref` is not an `<input type="password">`. |
| `origin_changed` | The page changed origin between the checks and the end of the fill. The filled fields are cleared. |
| `error` | Playwright failed. The message is fixed — a Playwright timeout can quote the value it was filling. |
| `filled` | Success. |

**Masking.** Every tool `createBrowserTools` returns is wrapped by `withSecretMask` (`secret-mask.ts`). After a fill, each filled value is replaced with `••••••` in every later browser tool result, error and progress event for that browser session — the aria snapshot otherwise prints a password input's current value. The values live in process memory until the session closes. Screenshots are not masked; a password field shows the browser's own bullets.

**TOTP.** RFC 6238: SHA-1, 6 digits, 30 s by default; an `otpauth://totp/` URI may set `algorithm` (`SHA1`, `SHA256`, `SHA512`), `digits` (6 or 8) and `period` (1–300 s). Anything else — HOTP, another algorithm or digit count, a `counter` parameter — is refused when the credential is stored. SMS, e-mail and push codes go through [takeover](#takeover).

## See also {#see-also}

- [Browser tools reference](../browser-tools.md): the index of every section and its page.
