# Ethos Security Model

This document defines the trust boundaries, threat model assumptions, and security architecture of Ethos.

## Deployment model

Ethos is a **single-user, localhost-first** agent framework. The primary deployment is:
- CLI running on the user's workstation
- All data stored under ~/.ethos/ (owned by the running user)
- LLM API calls to external providers (Anthropic, OpenAI, etc.)
- Optional: gateway mode exposing the agent via messaging platforms (Telegram, Slack, Discord)

## Trust boundaries

```
┌─────────────────────────────────────────────────────┐
│  TRUSTED: User's machine                            │
│  ┌───────────────┐  ┌──────────────────────────┐   │
│  │ CLI / Web UI  │  │ ~/.ethos/ (config, keys) │   │
│  └───────┬───────┘  └──────────────────────────┘   │
│          │                                          │
│  ┌───────▼───────────────────────────────────────┐  │
│  │ Agent Loop (core)                             │  │
│  │  ├─ Tool Registry (personality-gated)         │  │
│  │  ├─ Memory Provider (scope-partitioned)       │  │
│  │  └─ Session Store (per-personality-key)       │  │
│  └───────┬───────────────────────────────────────┘  │
│          │                                          │
└──────────┼──────────────────────────────────────────┘
           │ TRUST BOUNDARY
┌──────────▼──────────────────────────────────────────┐
│  UNTRUSTED: External                                │
│  ├─ LLM responses (may contain injection attempts)  │
│  ├─ Web content fetched by tools                    │
│  ├─ Channel messages (Telegram, Slack, etc.)        │
│  └─ Plugin code (local filesystem, user-installed)  │
└─────────────────────────────────────────────────────┘
```

## Security controls

### Authentication & authorization

| Surface | Control | Enforcement |
|---------|---------|-------------|
| CLI | Filesystem permissions on ~/.ethos/ | OS-level |
| Web API | Bearer token (generated at startup) | middleware/dual-auth.ts |
| ACP server | Bearer token + loopback bind | apps/acp-server/src/index.ts |
| Gateway channels | Channel filter + pairing DB | packages/safety/channel/ |
| Tool execution | Personality toolset allowlist | tool-registry.ts |
| File access | ScopedStorage boundary checks | storage-fs/src/scoped.ts |
| URL fetching | SSRF validator (private IP rejection) | core/url-validator.ts |

### Defense-in-depth layers

1. **Personality toolset** — LLM can only call tools in its allowlist
2. **ScopedStorage** — filesystem access confined to personality directory
3. **SSRF validator** — blocks private IPs, cloud metadata endpoints
4. **Terminal escape sanitization** — strips ANSI from all LLM/tool output
5. **Path boundary checks** — assertWithinBase on all path.join results
6. **Channel filter + pairing** — messaging platforms require explicit user approval
7. **Atomic writes** — config/state files use write-tmp-rename pattern

### What is NOT in scope (today)

- **Multi-tenant isolation** — no tenants exist; single-user only
- **Remote plugin sandboxing** — no plugin marketplace; local-only
- **LLM output verification** — we sanitize but don't verify correctness
- **Cryptographic integrity** — config files are not signed; trust is filesystem-permission-based

## Assumptions

1. The user's filesystem is trusted. If an attacker has write access to ~/.ethos/, the system is compromised regardless of application-level controls.
2. LLM responses are untrusted. Any text from the LLM may be a prompt injection attempt. Controls (toolset gating, path boundaries) limit the blast radius.
3. Network access is available but untrusted. All outbound fetches go through the SSRF validator. Inbound connections are loopback-only by default.
4. Channel messages are untrusted. The pairing/filter system gates who can interact with the agent.

## Incident response

Security vulnerabilities should be reported per SECURITY.md (GitHub private vulnerability reporting, 90-day coordinated disclosure).

---

*Last updated: 2026-05-15*
