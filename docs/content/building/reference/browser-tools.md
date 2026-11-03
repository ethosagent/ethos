---
title: Browser tools
description: "Browser tools for navigation, interaction, screenshots and vision-click, plus launch posture, profiles, bot walls, human takeover and stored-login fill."
kind: reference
audience: developer
slug: browser-tools
updated: 2026-11-03
---

# Browser tools

Ethos ships a Playwright-backed browser surface covering navigation, interaction by accessibility ref, vision-click, page-state introspection, and browser session management — **fourteen tools**, plus `browser_request_takeover` in any deployment that has an interactive surface to hand a browser to, and `browser_fill_credential` in any deployment that wires an observability sink. Personality lockdown gates which tools are visible per personality via the `toolset.yaml` allowlist.

## Source {#source}

Factory: [`extensions/tools-browser/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/index.ts) — `createBrowserTools`. Per-tool implementations split across `browser-actions.ts`, `browser-computed-style.ts`, `browser-screenshot.ts`, `browser-takeover.ts`, `browser-fill-credential.ts`, `credential-vault.ts`, `secret-mask.ts`, `totp.ts`, `browser-vision-click.ts`, `browser-vision-type.ts`, `snapshot.ts`, `sessions.ts`, `launch-options.ts`, `block-detector.ts`, `a11y.ts`. Wiring at [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts).

## Tools {#tools}

| Tool | Purpose | Capability |
|---|---|---|
| `browse_url` | Legacy single-shot load + extract. Prefer `browser_navigate` for new code. | `network: { allowedHosts: ['*'] }` |
| `browser_navigate` | Load a URL; canonical first call in any workflow. Returns the post-load accessibility snapshot. | `network: { allowedHosts: ['*'] }` |
| `browser_click` | Click an element by accessibility ref (`@e3`) from a snapshot. | none |
| `browser_type` | Type text into an element by ref. | none |
| `browser_press` | Send a keyboard key (`Enter`, `Tab`, `Escape`, `Control+A`). | none |
| `browser_scroll` | Scroll viewport (`up` / `down` / to a specific element by ref). | none |
| `browser_back` | Navigate browser history back one step. Returns updated snapshot. | none |
| `browser_console` | Dump recent console messages and JS errors collected since session start. | none |
| `browser_get_images` | List every `<img>` on the page with `src` + `alt` text. | none |
| `browser_computed_style` | Load a URL and report `getComputedStyle` per rendered element — colour, background, typography, border, shadow. Answers what a page *looks like*, where the snapshot answers what it *is*. | `network: { allowedHosts: ['*'] }` |
| `browser_dialog` | Accept / dismiss / answer a JS alert / confirm / prompt that's blocking the page. | none |
| `browser_screenshot` | Capture the viewport as a base64 JPEG. Use for `vision_analyze` composition. | none |
| `browser_vision_click` | Single tool that screenshots → vision model identifies the element → clicks. For pages with poor accessibility trees. | `vision: true` (transitively via `vision_analyze`) |
| `browser_vision_type` | Same idea: vision finds the input, then types. | `vision: true` |
| `browser_request_takeover` | Pause the agent and hand the live browser to a human, then wait for them to hand it back. Registered only when wiring supplies a `ClarifyBridge`. | none |
| `browser_fill_credential` | Fill a stored login (username, password, TOTP code) into the page by reference — the model never sees the values. Available only when wiring supplies an observability sink. See [stored-login fill](browser-tools/profiles-and-login.md#fill-credential). | `secrets: ['credentials/*']` |

All tools share `toolset: 'browser'`, so a personality opting in lists individual tools in `toolset.yaml` — they're not grouped under a single toolset name in the registry filter.

Every interaction tool returns the updated accessibility tree, so a fresh snapshot arrives with each result. There is no standalone `browser_snapshot` tool — `browse_url` and `browser_navigate` produce the first snapshot, and each click, type, scroll or back call produces the next.

## Accessibility-ref workflow {#a11y-workflow}

Most interaction work follows snapshot → click-by-ref:

```text
1. browser_navigate("https://example.com")
   → returns: accessibility snapshot with refs @e1, @e2, @e3, ...
2. browser_click("@e7")        # element 7; returns the post-click snapshot
3. browser_type("@e3", "hello world")   # refs from step 2's snapshot
```

Refs are stable within a single page-state but invalidate after navigation, click, or any DOM mutation. Always address elements by the refs in the *most recent* result, never by refs from an earlier one. The accessibility tree is what the model reasons over, not the rendered DOM — this gives stable element identity and avoids brittle CSS-selector authoring.

## Vision-click fallback {#vision-fallback}

Pages with poor accessibility (Canvas-rendered SPAs, JS-heavy widgets, custom roles) produce sparse snapshots. `browser_vision_click` and `browser_vision_type` route through the vision model to identify elements visually:

```text
browser_vision_click("the orange 'Sign up' button in the hero section")
```

Slower and costlier than ref-based clicks (one vision API call per interaction), so use as a fallback, not the default.

## Sessions {#sessions}

The browser surface manages Playwright sessions internally, keyed by `(sessionId, networkPolicy)`. A session outlives the turn that opened it: an idle sweeper closes sessions untouched for [`browser.idleTimeoutMs`](../../using/reference/config-yaml.md#browser) (default 10 minutes) and runs once a minute, and `SIGTERM` / `SIGINT` close every remaining session — awaiting `context.close()`, because a persistent context flushes its profile on close and killing only the browser handle would lose the login the profile exists for.

Two things a session is never reaped for. A session whose current page is being driven by a human is skipped by the sweeper for as long as the [takeover](browser-tools/profiles-and-login.md#takeover) is live. And when [profiles](browser-tools/profiles-and-login.md#profiles) are on, the cookies and storage a session accumulated survive the session's own death — they live in the profile directory, not the session.

## Capability declarations {#capabilities}

The wiring declares capabilities per tool. The personality-lockdown enforcement gate at [`packages/core/src/agent-loop.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop.ts) confirms each call's declared capabilities are satisfied. Today:

- **Network**: only `browse_url` and `browser_navigate` carry `network: { allowedHosts: ['*'] }`. Other browser tools operate on a page already loaded by one of these, so they don't independently re-declare network reach.
- **Vision**: `browser_vision_click` / `browser_vision_type` invoke `vision_analyze` internally, which carries `fs_reach: { read: 'from-personality' }` and the vision capability.

## Errors {#errors}

| Error | Cause |
|---|---|
| `Browser session not active — call browser_navigate first` | Tool requires a loaded page; agent skipped the navigate step |
| `Element ref @e<n> not found in current snapshot` | Stale ref; page mutated after the snapshot was taken |
| `Network request blocked: <host> not in allowlist` | Personality's `network` capability doesn't allow the domain |
| `Dialog already auto-dismissed` | Page raised a JS dialog before agent could respond; Playwright's default auto-dismisses |
| `Blocked by <vendor> bot protection …` | [Bot wall](browser-tools/profiles-and-login.md#bot-walls). The page was not read and nothing was retried. |
| `A human has taken over this browser session …` | A [takeover](browser-tools/profiles-and-login.md#takeover) is live. Code `not_available`, not a page failure — wait for the hand-back. |
| `This browser session is already handed to a human …` | `browser_request_takeover` called on a session that already holds a takeover lock. |
| `No one took over the browser within <n>s.` | Takeover timed out. The page is unchanged; report the blockage rather than retrying. |
| `The browser session was closed during the takeover …` | `/new`, an abort, or the operator closing the window while a human held it. |
| `Refused: the page, or the frame holding a target field, is not on an origin this credential is bound to …` | `browser_fill_credential` on a page (or in a frame) outside `policy.origins`. See [stored-login fill](browser-tools/profiles-and-login.md#fill-credential). |
| `Refused: credential fills are not allowed in an unattended run …` | A background job, or no surface registered for this platform, and the credential's policy does not set `unattended`. |
| `This personality is not allowed to use that credential …` | The personality is not in the credential's `policy.personalities`. Grant with `ethos secrets credential grant`. |
| `⚠ Browser profile '<id>' is in use by another session …` | Not an error — a notice on an otherwise successful result. This session fell back to an ephemeral context and is [not logged in](browser-tools/profiles-and-login.md#profiles). |

## Examples {#examples}

### Read JS errors from a page {#example-console}

```text
1. browser_navigate("https://app.example.com")
2. browser_console()
   → returns:
     [error] Uncaught TypeError: Cannot read 'foo' of undefined  (app.js:42)
     [warn]  Deprecated API usage in legacy-loader.js
```

### Fill and submit a form via accessibility refs {#example-form}

```text
1. browser_navigate("https://example.com/signup")
   → snapshot identifies @e5 (email input), @e6 (password), @e7 (submit)
2. browser_type("@e5", "alice@example.com")
3. browser_type("@e6", "correcthorsebatterystaple")
4. browser_click("@e7")
   → returns the post-submit snapshot
```

### Composite vision review {#example-vision-review}

```text
1. browser_navigate("https://example.com/dashboard")
2. browser_screenshot()
3. vision_analyze(image=<screenshot>, prompt="Identify any anomalies or out-of-range values.")
```

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="launch-posture"></a>[Launch posture](browser-tools/profiles-and-login.md#launch-posture) | [Browser tools: launch posture, profiles, bot walls and login](browser-tools/profiles-and-login.md) |
| <a id="profiles"></a>[Persistent profiles](browser-tools/profiles-and-login.md#profiles) | [Browser tools: launch posture, profiles, bot walls and login](browser-tools/profiles-and-login.md) |
| <a id="profiles-one-process"></a>[Run one process per profile](browser-tools/profiles-and-login.md#profiles-one-process) | [Browser tools: launch posture, profiles, bot walls and login](browser-tools/profiles-and-login.md) |
| <a id="bot-walls"></a>[Bot walls](browser-tools/profiles-and-login.md#bot-walls) | [Browser tools: launch posture, profiles, bot walls and login](browser-tools/profiles-and-login.md) |
| <a id="takeover"></a>[Human takeover](browser-tools/profiles-and-login.md#takeover) | [Browser tools: launch posture, profiles, bot walls and login](browser-tools/profiles-and-login.md) |
| <a id="fill-credential"></a>[Stored-login fill](browser-tools/profiles-and-login.md#fill-credential) | [Browser tools: launch posture, profiles, bot walls and login](browser-tools/profiles-and-login.md) |

## See also {#see-also}

- [`browser.*` config reference](../../using/reference/config-yaml.md#browser) — the operator keys behind headed mode, proxy, profiles and the idle sweep.
- [Security controls: the browser SSRF guard under a proxy](../../security/controls.md#ssrf-browser-proxy) — what `browser.proxy.server` does not protect.
- [`vision_analyze` reference](vision-tools.md) — pairs with `browser_screenshot` for visual page review.
- [Tool capabilities](tool-capabilities.md) — the capability declaration contract.
- [Tool interface](tool-interface.md) — the `Tool<TArgs>` shape every browser tool implements.
