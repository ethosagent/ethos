---
title: "config.yaml: background agents, browser and search keys"
description: "config.yaml background agent, browser and search keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys for background agents, the browser tool and web search. Part of the [config.yaml reference](../config-yaml.md).

## background.acp.agents.\<name\>.\* {#background-acp-agents}

Type: dotted roster · Default: unset (no ACP-native coding-agent job runners)

Real [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) coding-agent CLIs a background job can run on — Claude Code's official adapter, Gemini CLI, and any other CLI that speaks ACP's `session/*` methods over stdio. `<name>` is the id the job registers under (a `delegate_task` call's `runner` parameter names it directly, e.g. `runner: 'claude'` or `runner: 'gemini'`); each configured entry becomes its own independent job runner, never a single shared `'acp'` runner with a sub-parameter.

| Field | Type | Description |
|---|---|---|
| `background.acp.agents.<name>.command` | string | The ACP agent binary to exec inside the sandbox container. Required — an entry missing `command` or `image` is dropped entirely rather than half-built. |
| `background.acp.agents.<name>.args` | comma-separated list | Arguments after `command`, e.g. the flag that puts the CLI into ACP mode. Optional. |
| `background.acp.agents.<name>.image` | string | Digest-pinned container image (`@sha256:...`) with `command` reachable inside it. Required. A bare tag does not satisfy the containment posture this needs — same reason `pi_image` must be digest-pinned. |

```yaml
background.acp.agents.claude.command: claude-agent-acp
background.acp.agents.claude.image: localhost:5555/ethos-acp-claude@sha256:...

background.acp.agents.gemini.command: gemini
background.acp.agents.gemini.args: --acp
background.acp.agents.gemini.image: localhost:5555/ethos-acp-gemini@sha256:...
```

Notes:

- `gemini`'s `--acp` is the CLI's own documented flag ("Starts the agent in ACP mode" per `gemini --help`); `--experimental-acp` also exists but is deprecated in favor of it.
- An entry with both `command` and `image` set registers immediately; there is no separate enable switch. Removing an entry (or its `image`) unregisters that runner — a job naming it then gets the same `not_available` answer a machine that never built the image would.
- Each entry needs its own container image with credentials for that agent mounted in — there is no shared auth story across entries. Neither agent's credential mount is wired yet.

## browser.\<field\> {#browser}

Type: dotted group · Default: the per-field defaults below

How this machine launches Playwright browser sessions for the `browser` toolset. Every key here is an **operator** concern — posture for this host — not personality identity. Which personality may hand its browser to a human is its `toolset.yaml`'s business, not this block's.

| Field | Type | Default | Description |
|---|---|---|---|
| `navigationTimeoutMs` | integer (ms) | `30000` | Budget for one page load (`goto` / `goBack`). Must be `1000`–`600000`; an out-of-range value is **dropped**, leaving the default. |
| `commandTimeoutMs` | integer (ms) | `10000` | Budget for one element interaction (`click`). Same `1000`–`600000` bound, same drop-on-out-of-range. |
| `idleTimeoutMs` | integer (ms) | `600000` (10 min) | How long an untouched session survives before the idle sweeper closes it. Must be `60000`–`86400000`; out of range is dropped. Under a minute the sweeper would reap a session between two tool calls of one turn; past a day an open session is a leak, not a cache. A session handed to a human is skipped while the takeover is live. |
| `headed` | `true` \| `false` \| `auto` | `auto` | Whether a session launches with a visible window. `auto` — headed where this machine has a display, headless otherwise (default). `true` — always headed. `false` — always headless. Any other value is a **fatal** parse error. |
| `stealth.enabled` | boolean | `false` | Reserved. **Nothing reads this key yet** — see the note below. Strictly `true`/`false`; anything else is fatal. |
| `profiles.enabled` | boolean | `false` (absent = off) | Persistent per-personality browser profiles under `~/.ethos/browser-profiles/<personality-id>/`. Strictly `true`/`false`; anything else is fatal. |
| `proxy.server` | string | unset | Upstream proxy for every browser session. **Endpoint only — scheme, host and port.** A username, password, path, query or fragment in the URL is refused; credentials go in `proxy.username` and `proxy.password`. **Requires an explicit scheme** — `http`, `https`, `socks4` or `socks5`. A bare `myproxy:3128` is refused, because a URL parser reads `myproxy:` as the scheme. A malformed value is fatal. |
| `proxy.username` | string | unset | Proxy username. Fatal without `proxy.server`. |
| `proxy.password` | secret ref | unset | Proxy password. Supports `${secrets:…}` and is externalized on write. Fatal without `proxy.server`. |

```yaml
browser.headed: auto
browser.idleTimeoutMs: 600000
browser.profiles.enabled: true
browser.proxy.server: http://proxy.example.com:3128
browser.proxy.username: ethos
browser.proxy.password: ${secrets:browser/proxy/password}
```

Notes:

- **Two validation strictnesses, deliberately.** The three `*Ms` budgets are bounded numbers and an out-of-range value is dropped, so the operator keeps running the value they already had. `headed`, both `enabled` flags and the whole `proxy` block are **fatal at boot** instead. For these there is no "out of range" — `headed: flase` or `proxy.server: myproxy:3128` is an operator stating an intent, and substituting the framework default for it is exactly how a proxy someone believed was carrying their traffic ends up not carrying it. Boot refuses rather than fail open.
- **`headed` absent now means `auto`, and that is a visible change on upgrade.** Earlier releases always launched headless. On macOS and Windows, and on Linux/BSD with `DISPLAY` or `WAYLAND_DISPLAY` set, a real Chromium window now appears on the first `browse_url`. Set `browser.headed: false` to keep the old behaviour.
- `headed: true` on a machine with no display does **not** fail. It falls back to headless and the session reports the fallback once: `⚠ browser.headed: true, but this machine has no display (no DISPLAY or WAYLAND_DISPLAY) — running headless.`
- **`profiles.enabled` is safe for one Ethos process at a time.** The mutex that serialises two sessions over the same profile directory is in-memory and process-local, so a second process on the same host running the same personality (`ethos serve` beside `ethos gateway`, the desktop app beside a CLI chat) never sees it. It collides at Chromium's own single-instance lock on the user data directory instead, and its browser **fails to launch** — there is no 15-second wait and no ephemeral fallback across processes. Run one process per personality profile, or set `profiles.enabled: false` on the secondary. See [run one process per profile](../../../building/reference/browser-tools.md#profiles-one-process).
- **`stealth.enabled` has no consumer.** No stealth engine and no stealth-tier tool ship in this release; the key parses and is stored, and nothing reads it. Setting it to `true` changes no behaviour.
- `proxy.password` is never returned resolved to the web UI — Settings shows a redacted preview, the same as `voice.trunk.password`. `proxy.server` carries no such redaction, which is why an embedded `user:password@` in it is refused rather than stored: the URL form would put the password in `config.yaml` in plaintext and hand it back on every read.
- **The browser SSRF guard does not survive a proxy.** Read [the browser proxy limit](../../../security/controls.md#ssrf-browser-proxy) before setting `proxy.server`.
- Profiles are keyed by personality id and the id must match `[A-Za-z0-9_-]+`; one that does not is silently ignored rather than allowed to name a directory. See [Persistent profiles](../../../building/reference/browser-tools.md#profiles) for what a profile holds and what happens when two sessions want the same one.

## web.searxng.url {#web-searxng}

Type: string · Default: unset — the rung is not offered

A self-hosted [SearXNG](https://docs.searxng.org/) metasearch endpoint, offered to `web_search` as a **keyless last rung**. It takes no API key and holds no secret ref, so it is tried only after a personality's configured provider, the global tool settings, and every keyed backend with a key present have all come up empty.

```yaml
web.searxng.url: http://searxng.internal:8080
```

Notes:

- Taken verbatim and unvalidated, like `web.host` and `web.corsOrigins`. A value that is not a parseable URL means the rung is simply not offered; a wrong-but-parseable endpoint fails loudly at the first search, naming the host and the key.
- Useful next to [bot-wall detection](../../../building/reference/browser-tools.md#bot-walls): when a page is walled, a search rung you host yourself is one of the few paths that does not depend on the walled vendor.

## activeContext {#active-context}

Type: managed · Required: no

Managed by `ethos set personality <id>` / `ethos set team <name>`. The runtime writes two dotted keys: `activeContext.type` (`personality` | `team`) and `activeContext.name` (id or team name). Hand-editing is not supported — values are interpreted only when both keys are present and `type` is recognised.

Notes:

- `activeContext.type: personality` is deprecated for one release: on load it is migrated to `personality: <name>` and the file is rewritten automatically, with a warning saying no action is needed (`migrateActiveContextPersonality` in `packages/config/src/index.ts`). The team form is unchanged — `activeContext` now only names a team.

## File location and permissions {#file-location}

`~/.ethos/config.yaml` is written by `ethos setup` and `ethos personality set`. The companion `~/.ethos/keys.json` (chmod 600) holds the rotation pool — manage it through `ethos keys`, not by hand.

The directory can be relocated with the `ETHOS_STATE_DIR` env var, read by `ethosDir()` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts).

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
