# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **TUI onboarding wizard** — `ethos setup` on a TTY now opens an Ink-based wizard instead of a readline Q&A. 8-step Quick path and 12-step Full path with ↑↓ Enter Esc Space navigation. Ctrl+C aborts cleanly without writing config.
- **Personality picker** — step 5 shows each built-in personality's 4-cell FNV-1a mark slice + accent stripe. The wizard cursor shifts to `personalityAccent(<chosen>)` for steps 6–8, realising the "personality is architecture" thesis during first-run.
- **Provider catalog** (`packages/wiring/src/provider-catalog.ts`) — 7 providers (Anthropic, OpenAI, OpenRouter, Gemini, Groq, DeepSeek, Ollama) with auth type, cost type, recommended tier, and expand-all affordance.
- **Model catalog** (`packages/wiring/src/model-catalog.ts`) — 18 model entries with context windows; amber warning when selected model is under 64k context.
- **Summary block** — borderless `─ summary ─` + `─ useful commands ─` block at the end of setup. No "Configuration Complete!" banner (anti-slop voice rule).
- **Launch chat now?** — Y/n prompt at the end of setup that drops directly into `runChat()` in the same process without a second invocation.
- **Section-scoped re-entry** — `ethos setup model | auth | personality | messaging | memory | providers | keys` opens the wizard at the relevant step with current values pre-filled.
- **`ethos gateway setup` alias** — now routes through the TUI wizard at the messaging step; legacy readline path kept for non-TTY environments.
- **Platform token validators** — `extensions/platform-telegram/src/validate.ts`, `extensions/platform-discord/src/validate.ts`, `extensions/platform-slack/src/validate.ts` each expose a `validate*Token()` function with 3-second timeout. MessagingStep calls them live; on success shows `✓ @botname`; on failure shows the error with option to retry or save anyway.
- **`ethos doctor --fix`** — auto-repairs: creates `~/.ethos/personalities/` if absent, seeds `MEMORY.md` / `USER.md`, fixes `keys.json` permissions to 0o600, warns on unknown provider with closest-match suggestion.
- **Full Setup path** — four Full-only steps (MultiProvider chain, KeyRotation pool, Memory backend, DaemonInstall) rendered when user selects Full mode in step 1.
- **readline fallback** — `ethos setup < /dev/null` still runs the original readline Q&A; no Ink module imported in non-TTY environments.

### Changed

- `apps/ethos/src/commands/setup.ts` — `runSetup()` now returns `{ config, launchChat } | null` instead of `EthosConfig | null`; callers updated.
- `apps/ethos/src/commands/gateway.ts` — `runGatewaySetup` export removed from public CLI dispatch; replaced by `ethos setup messaging` alias.
