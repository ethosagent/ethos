---
title: "Changelog"
description: "Ethos version history — material changes and breaking notes per release."
kind: reference
audience: shared
slug: changelog
updated: 2026-09-25
---

Version history for the `@ethosagent/cli` and its workspace packages. The current version lives in the [`VERSION`](https://github.com/ethosagent/ethos/blob/main/VERSION) file at the repo root. Entries are newest first.

## Source {#source}

Entries are seeded from the commit log on `main`. For the canonical machine-readable view, run `git log --oneline` in the repo, or browse the [GitHub commit history](https://github.com/ethosagent/ethos/commits/main).

Entries from 0.4.16 onward are generated from `git log --no-merges v<previous>..v<version>` between consecutive release tags: every `feat` subject verbatim, every subject without a conventional type verbatim, every subject marked `!` under **Breaking**, and the remaining types as counts. Each entry names its exact command, so any entry can be re-checked against the repo. A version in the `VERSION` file with no release tag yet has no entry.

## Conventions {#conventions}

- **Date** · ISO-8601 (YYYY-MM-DD).
- **Status** · `alpha` (interfaces may break without notice), `beta` (stable interfaces, evolving features), `stable` (semantic-version contract).
- **Highlights** · Three lines, one per headline feature.
- **Notable changes** · One bullet per material change.
- **Breaking** · One bullet per breaking change, or "None".
- **Commits** · For generated entries, the number of non-merge commits since the previous tag. Generated entries carry no Status.

| Version | Date | Status | Commits |
|---|---|---|---|
| [0.7.3](#v0-7-3) | 2026-09-03 | — | 17 |
| [0.7.2](#v0-7-2) | 2026-08-31 | — | 3 |
| [0.7.1](#v0-7-1) | 2026-08-30 | — | 9 |
| [0.7.0](#v0-7-0) | 2026-08-29 | — | 163 |
| [0.6.2](#v0-6-2) | 2026-08-09 | — | 28 |
| [0.6.1](#v0-6-1) | 2026-08-06 | — | 14 |
| [0.6.0](#v0-6-0) | 2026-08-06 | — | 86 |
| [0.5.3](#v0-5-3) | 2026-07-14 | — | 2 |
| [0.5.2](#v0-5-2) | 2026-07-14 | — | 69 |
| [0.5.1](#v0-5-1) | 2026-06-26 | — | 2 |
| [0.5.0](#v0-5-0) | 2026-06-26 | — | 39 |
| [0.4.21](#v0-4-21) | 2026-06-24 | — | 3 |
| [0.4.20](#v0-4-20) | 2026-06-24 | — | 2 |
| [0.4.19](#v0-4-19) | 2026-06-24 | — | 96 |
| [0.4.18](#v0-4-18) | 2026-06-16 | — | 2 |
| [0.4.17](#v0-4-17) | 2026-06-16 | — | 19 |
| [0.4.16](#v0-4-16) | 2026-06-15 | — | 26 |
| [0.4.15](#v0-4-15) | 2026-06-09 | beta | — |
| [0.2.7](#v0-2-7) | 2026-05-11 | beta | — |
| [0.2.6](#v0-2-6) | 2026-04-28 | beta | — |
| [0.2.5](#v0-2-5) | 2026-04-10 | beta | — |

## 0.7.3 {#v0-7-3}

Date · 2026-09-03
Commits · 17 since 0.7.2 (`git log --oneline --no-merges v0.7.2..v0.7.3`)

Features (9)

- **web** · surface the MCP catalog inline on both MCP surfaces
- **webhook** · event filtering, delivery fan-out, HMAC and rate limiting
- **bedrock** · resolve AWS credentials via the standard provider chain
- **documents** · upload files, create folders, browse multiple workdir roots
- **web** · Keys page — one masked inventory over the whole secrets vault
- **gateway** · live config reload for bots, webhooks and web bind
- **config** · add 12 config fields with runtime enforcement and Settings UI
- **mcp** · curated default server catalog, served over oRPC
- **observability** · add memory-write and HTTP-request counters to /metrics

Other commits · 4 `fix`, 3 `chore`, 1 `refactor`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.7.2 {#v0-7-2}

Date · 2026-08-31
Commits · 3 since 0.7.1 (`git log --oneline --no-merges v0.7.1..v0.7.2`)

Features (1)

- **web-api** · add ETHOS_ALLOWED_ORIGINS for the CSRF origin allow-list

Other commits · 2 `chore`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.7.1 {#v0-7-1}

Date · 2026-08-30
Commits · 9 since 0.7.0 (`git log --oneline --no-merges v0.7.0..v0.7.1`)

Features (2)

- **docker** · default ETHOS_MODE to boot for single-tenant deployments
- **pause-lifecycle** · add HttpPauseLifecycle, the first real idle-signal implementation

Other commits · 5 `fix`, 1 `chore`, 1 `docs`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.7.0 {#v0-7-0}

Date · 2026-08-29
Commits · 163 since 0.6.2 (`git log --oneline --no-merges v0.6.2..v0.7.0`)

Features (86)

- **tools-reddit** · add reddit_search tool with credential help affordance
- Telegram/Slack webhook mode, and a clock-tolerance pass that actually fires
- **skills** · add xurl skill for X/Twitter posting and account-scoped access
- **tools-x-search** · add native x_search tool for xAI's X search API
- **makefile** · add make boot target for the merged gateway+serve profile
- approval timeouts, idle-watcher, and the single-process boot profile
- **wiring** · register ACP job runners from background.acp.agents config (T4/I3)
- **execution-coding-agents** · add generic AcpHost/AcpGate skeleton, proven against Claude Code's ACP adapter (T2/T3)
- **job-runner** · add runner-agnostic log sink (T1/I-LOG1)
- **kanban** · add notify/wake delivery modes (Lane C, Phases 2-3)
- **a2a** · correctness + mesh hardening (Tier 0 + Tier 1)
- **kanban** · add six dispatcher/tool lifecycle Void hooks (Lane B Phase 1)
- **kanban** · add kanban_create_swarm atomic root/worker/verifier/synthesizer DAG (Lane A Phase 5)
- **kanban** · add dashboard bulk status-update and bulk-assign actions
- **kanban** · live board updates via SSE, replacing poll (Lane A Phase 3)
- **kanban** · add kanban_decompose auxiliary-LLM goal fan-out tool
- **kanban** · typed block reasons + unblock-loop breaker
- **cron** · split CronScheduler into CronEngine + CronTriggerSource + CronArmingBackend
- **core** · record model-visible context as a content-addressed log (model-visible-logged)
- **web** · delegated-run card, digest, and completion hand-back (I14–I18)
- **clarify** · escalate an unanswered question to the run's origin lane (I20)
- **job-store** · bounded tail read + real `artifact_change` rows (I21, I22)
- **worker-router** · park a run on `blocked` while a human answers (I11 x I19)
- **worker-router** · route worker interactions to a capability or a human (I19)
- **jobs** · blocked job status, run.update SSE schema, runner-accent design amendment
- **observability** · Prometheus counters, Langfuse exporter, and Grafana dashboard
- **execution-pi** · sandboxed Pi job runner with worktree-per-run (I9/I10)
- **job-runner** · extract the JobRunner seam (I6/I7/I8)
- **clarify** · wire ClarifyBridge origin resolver into production wiring
- **openai-api** · wire idempotency, add /v1/capabilities + /v1/audio/transcriptions, web.* config keys
- **personalities** · add avatar picker, hide system agents from nav
- **voice** · tool-call filler + tick feedback, fix browser-voice bugs found in review
- **web** · surface voice.bargeIn.browser in Settings, reconcile legacy sliders
- **voice** · unify browser talk onto VoiceSession, add browser barge-in tuning
- **callcapture** · local ambient call detection, capture, and transcription
- **web** · personality-first UI — two-altitude nav (AltitudeRail + ScopeNav)
- **web** · close settings-navigation Card gap for automation and jobs panes
- **web,platform-voice** · callouts and self-save markers (Phase 7)
- **web** · tables for repeatable settings data (Phase 6)
- **web** · convert Voice pane telephony half off VoiceSectionLabel onto SettingRow (Phase 5b)
- **web** · convert Voice pane providers half off Card onto SettingRow (Phase 5a)
- **web** · move Settings' Machine group off Card onto SettingRow (Phase 4)
- **web** · move Settings' Agent group off Card onto SettingRow (Phase 3)
- **web** · give Settings an index, a search, live counts and a dim advanced toggle
- **web** · route Settings as a two-pane surface, with the form above the outlet
- **voice,telephony** · answer the phone — V4 telephony wired end to end
- **voice** · say the personality's name; make listen owns the microphone
- **ethos,session-sqlite,observability-sqlite** · rework ethos usage
- **core,wiring** · record skill exposures and invocations
- **platform-slack,platform-discord,ethos** · record adapter-local safety blocks
- **voice** · the wake phrase actually picks the personality
- **core,types,session-sqlite,llm-gemini,tools-vision** · native multimodal turns
- **voice** · "hey `<name>`" — wake-word satellites with personality routing
- **voice** · voice notes everywhere — channel STT-in / TTS-out
- **web** · Call Stage — a voice call becomes its own view mode
- **web** · ask clarify questions by voice during a call
- **web,config,web-api** · call overlay, and fix four voice-call defects
- **web** · report realtime turn latency from the browser
- **platform-slack,types,gateway,config** · snippet fallback for long Slack replies
- **platform-slack** · resolve Slack user ids to display names
- **platform-slack,config** · allowlist bot and workflow messages
- **config,ethos** · wire the Slack adapter's built-but-unpassed config
- **core,types,llm-anthropic,llm-openai-compat** · correlate calls with provider request ids
- **web-api,core,types,web-contracts** · request ids and one turn identity
- **core,types** · put cost on the llm_call span and cache tokens on usage events
- **pricing,llm-*,session-sqlite,ethos** · one cache-aware rate table
- **types,core,session-sqlite** · populate the dead messages.trace_id column
- **core,session-sqlite,observability-sqlite** · write session usage rollups per turn
- **voice,core,web,web-api** · realtime per-minute cost, session cap, spoken wind-down
- **voice,core,web,web-api** · agent_consult, talk-session lane, transcript persistence
- **voice** · browser realtime tier over ephemeral tokens
- **config,web,web-api,types,personalities** · realtime voice roster and tier default
- **voice-providers** · OpenAI Realtime and Gemini Live providers
- **types** · RealtimeVoiceProvider contract for hosted speech-to-speech
- **config,core,web,web-api,personalities** · symmetric STT/TTS provider rosters
- **web,web-api,web-contracts,personalities** · voice provider roster editor and per-personality voice UI
- **config,core,types,personalities,web-api** · TTS provider roster selectable per personality
- **web,web-api,config,voice-session** · CallStrip states, Settings parity, first-run, a11y, live latency bench
- **personalities,core,wiring,gateway,web-api,web** · voice personality, voice-origin turns, audible personality voice
- **web,web-api,web-contracts** · binary PCM voice socket, WebAudio playout, staleness discipline
- **types,core,wiring,safety,plugin-loader,personalities,docs** · publish and enforce the security boundary
- **voice-providers,voice-session,config** · streaming TTS with prefetch; fix inert knobs and broken recipes
- **types,voice-providers,personalities,core** · buffer-based STT contract + personality voice
- **wiring,core,voice-session,gateway,web-api** · wire the voice stack and one provider path
- **core,types,session-sqlite,web-api,ethos,tui** · bind session personality at creation
- **web-contracts,tools-ui,web-api,web,core** · typed UI cards + sandboxed personality Canvas

Commits without a conventional type (1)

- docs+test(execution-coding-agents): T5 — verify Gemini CLI as second ACP agent, config-only

Other commits · 50 `fix`, 7 `chore`, 7 `docs`, 4 `test`, 3 `ci`, 3 `refactor`, 1 `wip`, 1 `perf`.

Breaking

- fix(platform-slack,ethos)!: default-deny Slack slash commands and App Home
- feat(types,voice-providers,personalities,core)!: buffer-based STT contract + personality voice

## 0.6.2 {#v0-6-2}

Date · 2026-08-09
Commits · 28 since 0.6.1 (`git log --oneline --no-merges v0.6.1..v0.6.2`)

Features (18)

- **web** · favourite a personality so the picker remembers it
- **web** · preview workdir files in a modal instead of downloading them
- **web-api,cli,web-contracts** · API key scopes + origin allowlist
- **core,wiring,tools-ui,web** · one output home per personality
- **web** · Documents tab
- **web-api,web-contracts** · documents service, RPC + streaming download
- **core,execution-docker** · the turn's working dir comes from the personality
- **types,storage-fs** · size + mtime on StorageDirEntry
- **docs,personalities,web** · Lane E — sheet line, docs, and the heatmap spec fix
- **web,ui-components** · Lane B — echarts fence renderer, gated on skill declaration
- **wiring,web-api,web** · Lane C — personality skill set → renderer activation
- **skills,types** · Lanes A+D — ethos.renders declaration + charts skill
- **personalities,docs** · script-callable surface on the character sheet + how-to page
- **core,types,surfaces** · inner-call observability for in-script tool calls
- **core** · exclude credential-bearing terminal/debug tools from SCRIPT_SAFE
- **core,tools-code** · ScriptToolBridge — in-script tool calls through the turn's enforcement path
- **execution** · framed stdio RPC transport for in-script tool calls
- **core** · SCRIPT_SAFE policy + scriptCallableFor derivation

Other commits · 7 `fix`, 1 `release`, 1 `docs`, 1 `refactor`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.6.1 {#v0-6-1}

Date · 2026-08-06
Commits · 14 since 0.6.0 (`git log --oneline --no-merges v0.6.0..v0.6.1`)

Other commits · 6 `fix`, 5 `ci`, 3 `chore`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.6.0 {#v0-6-0}

Date · 2026-08-06
Commits · 86 since 0.5.3 (`git log --oneline --no-merges v0.5.3..v0.6.0`)

Features (51)

- **wiring,personalities** · Lane 6 — arithmetic model-fit verdict (fits/degraded/refuses/unknown) in character sheet + RPC
- **llm-openai-compat** · Lane 4b — reasoning passthrough, vLLM strict tools, process-lifetime text-tool-call latch, topK/minP wiring
- **llm-openai-compat,wiring** · Lane 3 — dialect-gated schema sanitizer, payload guard, schema-budget warning, declared small-window toolset narrowing
- **core,wiring** · Lane 1 delta — compactible-region term, startup floor warning via shared measureStaticFloor, window-scaled result budget with ingestion truncation, quantized aging buckets
- **core,providers** · Lane 2 — deterministic tool ordering, restart-prefix test, golden-body harness
- **wiring** · Lane 0 — probe served windows, config-first precedence, per-runtime cap, contextWindow key, probe cache
- **skills** · add no-ai-slop editing skill
- **core** · per-turn micro-compaction and ghost-skill markers
- **types** · onTurnComplete hook on ContextEngine, wired and governed
- **jobs** · richer job events and restart-durable completion delivery
- **gateway** · durable delivery-obligation ledger with ownership-checked redelivery
- **core** · absolute compaction threshold, user-message tail guarantee, spill-path preservation
- **wiring** · default consequential-tool flag set for smart approval mode
- **apps** · thread personality and provider into the danger predicate
- **wiring** · LLM-judged smart approvals with deny rules and denial breaker
- **tools** · self-recovery for patch, write, search, and terminal truncation
- **core** · raise iteration cap to 500 with in-loop cost enforcement
- **skills** · grounded-citations — quote verification and fact-check mode
- **web** · webhooks move to Personality page as Triggers section
- **web** · full config.yaml coverage in Settings UI
- **webhook** · prefilter gate + fast ACK mode (event-triggers Phase 4)
- **watchers** · deterministic watcher primitives (event-triggers Phase 3)
- **cron** · script-file cron jobs + precheck gate (event-triggers Phases 1-2)
- **compaction** · standing-instruction preservation + autoCompact default-on (context-economy Phase 2)
- **cron** · zero-LLM script jobs (context-economy Phase 1b)
- **gateway** · pre-LLM quick-command shortcuts + per-channel toolset narrowing (context-economy Phase 1a)
- **bench** · ethos bench context — per-section token measurement baselines (context-economy Phase 0)
- **voice** · live VAD/barge-in tuning controls in Settings
- **voice** · stream reply for faster first-audio + configurable thinking chime
- **voice** · turn-based browser talk-mode (LiveKit-free, over existing RPCs)
- **web-settings** · gate voice Base URL to local providers + add STT/TTS test buttons
- **voice** · Phase D meeting-join (transcribe-only) behind MeetingClient boundary
- **voice** · Phase C telephony/SIP behind SipTrunkClient boundary
- **memory** · L4 — minimal fact lifecycle (active/superseded/retracted)
- **memory** · L3 — approval UX (pending RPCs + web Pending queue)
- **voice** · Phase B web talk-mode UI (toolset-gated call affordance)
- **memory** · L2 — approve-before-store gate (PendingMemoryGate)
- **voice** · Phase B LiveKit transport behind isolated boundary
- **memory** · L1 — bring-your-own-vault MemoryProvider backend
- **voice** · Phase B core — transport-agnostic voice channel adapter + config binding
- **voice** · Phase A — VoiceSession streaming orchestrator, contracts, latency harness
- **web** · quiet "· remembered" toast on proactive memory capture
- **web-settings** · surface behavior flags as Settings toggles
- **memory** · provenance history + proactive capture + reversible decay + timeline
- **compaction** · activate context compaction — measure, model-aware gate, /compact, decay defenses
- **tools** · per-personality tool settings — global named secrets + web_search pilot
- **onboarding** · zero-friction first hour — funnel, Docker, validation, alive channels
- **personalities** · hot-reload seams — refresh-on-resolve, validate-on-switch, real /personality list
- **chat** · show current context size in web composer + CLI prompt
- **docs** · 3D hybrid landing page — orbit hero, tilting terminal, scroll conveyor
- **background** · durable background sub-agents — spawn-and-continue, wake-on-complete, mesh

Other commits · 25 `fix`, 4 `chore`, 4 `docs`, 1 `test`, 1 `refactor`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.5.3 {#v0-5-3}

Date · 2026-07-14
Commits · 2 since 0.5.2 (`git log --oneline --no-merges v0.5.2..v0.5.3`)

Other commits · 1 `chore`, 1 `fix`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.5.2 {#v0-5-2}

Date · 2026-07-14
Commits · 69 since 0.5.1 (`git log --oneline --no-merges v0.5.1..v0.5.2`)

Features (45)

- **web** · voice settings — configure local STT/TTS (URL, optional key, free-form voice id)
- **voice** · local STT/TTS providers over OpenAI-compatible endpoints (Kokoro, Whisper)
- **eval** · local-model eval suite — dataset, ethos eval local, qualifying doc
- **delegation** · return_mode summary for delegate_task
- **prompt** · lean system prompts — index-mode personality skills + promptBudget knob
- **compaction** · configurable thresholds + per-model charsPerToken
- **core** · reject repaired tool args missing required schema fields
- **models** · grammar-constrained structured outputs via providerOptions
- **setup** · local-provider branch in the Ink TUI wizard + shared /v1/models helper
- **setup** · local endpoint support — vllm preset, ollama shipping, no-API-key setup branch
- **models** · minimal per-model config profile (sampling, toolCallFormat, maxOutputTokens)
- **web** · wire session right-click context menu (pin/unpin + actions)
- **a2a** · peering CLI + UI — identity, allowlist admin, live enablement
- **a2a** · Phase 9 — egress allowlist + multi-tenancy hardening
- **a2a** · Phase 8 — metadata-only exchange audit + opt-in mesh self-loop guard
- **a2a** · Phase 7 — outbound client + communication skills
- **a2a** · Phase 6 — async lifecycle + P8 delegation containment
- **a2a** · Phase 5 — JSON-RPC execute-task, call-time scope, per-request PoP, serve wiring
- **a2a** · Phase 4 — auth handshake (default-deny, nonce/challenge/token)
- **a2a** · Phase 3 — packages/a2a card serving + client verification
- **a2a** · Phase 2 — explicit web-api route-registration seam
- **a2a** · Phase 1 — identity in core (AgentCard + getIdentity + Ed25519 signing)
- **gateway** · P5 — correctness + quota enforcement
- **security** · P2 hardening — secrets, deny-manifest, FsStorage confinement, dashboard, plugin gate
- **storage** · versioned SQLite migration harness + S3 storage backend
- Proactive autonomy: the always-on colleague
- **cron** · in-app delivery for personality heartbeats from web UI
- **voice,desktop** · TTS playback + direct web-token cookie auth
- **goals** · planning phase — read-only plan turn gates execution, PLAN node in graph
- **goals** · judge executes AcceptanceCheck.command (exit 0 = pass, 30s timeout)
- **goals** · structured halt events + goal-runner recovery, transient-error retry
- **goals** · true loop detection + per-goal maxIdenticalToolCalls override
- **core,safety** · raise loop-guard defaults — maxIdenticalToolCalls 25, rate limit 60/60s
- **web** · attach button opens a dropdown menu
- **web** · scroll-to-bottom button when viewing older messages
- **voice** · TTS playback — play button on assistant messages + TTS settings
- **voice** · live config reload + VoiceService tests
- **voice** · web/desktop voice recording + settings + gap fixes
- **voice** · third-party provider proof — ElevenLabs TTS, zero core edits (Phase 7)
- **voice** · trusted-plugin allowlist + conformance harness + template (Phase 6)
- **voice** · reference providers + wiring (Phase 5)
- **voice** · TTS pipeline — /voice command + post-turn synthesis (Phase 4)
- **voice** · STT pipeline — auto-transcribe audio before agent turn (Phase 3)
- **voice** · add 'audio' attachment type + Telegram voice plumbing (Phase 2)
- **voice** · add voice provider contracts + registry + plugin API (Phase 1)

Other commits · 13 `fix`, 3 `docs`, 3 `refactor`, 2 `chore`, 2 `style`, 1 `test`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.5.1 {#v0-5-1}

Date · 2026-06-26
Commits · 2 since 0.5.0 (`git log --oneline --no-merges v0.5.0..v0.5.1`)

Other commits · 1 `chore`, 1 `fix`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.5.0 {#v0-5-0}

Date · 2026-06-26
Commits · 39 since 0.4.21 (`git log --oneline --no-merges v0.4.21..v0.5.0`)

Features (19)

- **web** · add admin panel toggle in Settings
- **kanban** · untrimmed final output, @-tag agents to notify, editable assignee in modal
- **web** · kanban comments newest-first with composer on top
- **web** · task detail as large modal — toggleable events pane, pinned comment composer, expandable comments
- **kanban** · two-way comment thread — drawer view, agent activity log, human comments, notify-on-comment
- **web** · full-screen kanban board, new-task modal, connect-agents help panel
- **gateway** · inbound webhooks (POST /webhook/`<hookId>` → personality turn)
- **web** · add Kanban page as sidebar nav item under Advanced
- add global kanban board for independent agents
- **web** · surface kanban board in Settings -> advanced with task create + assignee picker
- **kanban** · add createTask, listAgents, assign RPCs for human task management
- **serve** · add config-driven kanban poll loop
- **dispatcher** · repoint addressing to AgentMesh + deliver via /notify
- **agent-mesh** · extend MeshEntry with personalityId, displayName, boardSubscriptions
- **acp-server** · add /notify doorbell intake + SessionLane serialization
- DocumentExtractor capability class + built-in extractors
- attachment classifier + plain-text inline + clear unsupported errors
- **tools-web** · multi-provider web_search + size-tiered extract summarization
- **personality** · portable export/import with faithful reproduction

Other commits · 14 `fix`, 2 `chore`, 2 `style`, 1 `test`, 1 `refactor`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.21 {#v0-4-21}

Date · 2026-06-24
Commits · 3 since 0.4.20 (`git log --oneline --no-merges v0.4.20..v0.4.21`)

Other commits · 2 `fix`, 1 `chore`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.20 {#v0-4-20}

Date · 2026-06-24
Commits · 2 since 0.4.19 (`git log --oneline --no-merges v0.4.19..v0.4.20`)

Other commits · 1 `chore`, 1 `fix`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.19 {#v0-4-19}

Date · 2026-06-24
Commits · 96 since 0.4.18 (`git log --oneline --no-merges v0.4.18..v0.4.19`)

Features (36)

- **secrets** · route codex OAuth tokens through SecretsResolver; deprecate plaintext apiKey fallback
- add /learn command for governed knowledge capture
- **llm** · make bedrock + gemini-native first-party plugins
- **cron** · consolidate system cron jobs into CronScheduler
- **llm** · migrate built-in LLM providers to plugin activate() contract
- **goals** · disable automatic goal detection; create goals only via Send as Goal
- **plugin-sdk** · add storage + execution backend SDKs
- **gateway** · Gap A — botKey fallback + trust gate + channel conformance
- **oauth,llm** · Gap C + B — OAuth prod service + LLM provider trust gate
- LLM Provider SDK — providers as plugins, not core PRs
- **command-sdk** · §9.6–9.7 — help/discovery + conformance harness
- **command-sdk** · §9.5 — toolsetNarrow for command tool-grant intersection
- **command-sdk** · §9.1–9.3 — CLI subcommand registry, CliSubcommandContext, unified CommandDefinition
- **wiring** · connect plugin-contributed adapters to gateway
- **gateway** · wire plugin-contributed adapters through Channel SDK
- replace better-sqlite3 with node:sqlite via @ethosagent/sqlite shim
- **core** · context compaction SDK — enriched engine contract, handles, conformance harness
- **web** · add Remove button for MCP servers on personality detail
- **oauth** · add OAuthService + registry + single-flight refresh
- **oauth** · add device-code flow strategy (RFC 8628)
- **oauth** · add loopback callback server (RFC 8252)
- **oauth-core** · add PKCE, authorization, token, and state protocol functions
- **oauth** · add OAuthTokenStore with encrypted-ready token persistence
- **oauth-core** · add OAuth metadata discovery and DCR parsing
- **web** · tool description tooltips on personality profile + create wizard
- **web** · detailed personality profile + clickable list names
- **web** · categorized toolset in the create wizard w/ boundary chips + (i) drawer (E3)
- **web** · toolset category map + boundary helpers (E3 foundation)
- phase 2a lane E2 — web Execution UI (personality editor tab + toolset link)
- phase 2a lane E1 — execution posture resolver + character-sheet Execution section
- phase 2a lane D2 — wire personality network policy to container network mode
- phase 2a lane D1 — constitution layer + budget clamp
- phase 2a lane C2 — exit-code propagation + containerized process lifecycle
- phase 2a lane C1 — container lifecycle core (persistent session, hash-recreate, A6)
- phase 2a lane B — route exec tools through backend + fs_reach as docker mounts
- phase 2a lane A — ExecutionBackend abstraction + local/docker/ssh backends

Commits without a conventional type (27)

- Add @ethosagent/oauth-core — OAuth/PKCE type contracts
- Add per-personality nightly governance (judge, master, expression toggles)
- Add skill-evolution promotion gate, scope, and create/evolve split
- Add a pending skill-candidate review queue to the web UI
- Surface dreaming cadence, skill-evolver model, and nightly status
- Surface per-personality safety mode and memory backend in the editor
- Make the personality detail page the editable governance surface
- Add digest "Generate now" via an extracted @ethosagent/digest package
- Enrich the personality detail page into a tabbed overview
- Surface judge alignment and the latest digest in the web UI
- Surface evolution_approval_mode + skill_evolution in the web editor
- Phase 3e: weekly governed-learning digest
- Phase 3d: close the skill-evolution loop through the nightly pass
- Fix: personality update() no longer drops config fields on rewrite
- Phase 3c: per-personality dreaming toggle (Quick-win)
- Phase 3c: schedule the nightly pass (default-off cron flag)
- Phase 3c: on-demand `ethos nightly run` (real orchestrator deps)
- Phase 3c: nightly-pass orchestrator (injectable, idempotent)
- Phase 3c: memory consolidation module (nightly-loop scaffold)
- Phase 3b: judge CLI + auto-mode Expression apply gate
- Phase 3b: Personality Judge (EvalRunner consumer)
- Phase 3a: use radius token in LivingSoulSection
- Phase 3a: web UI for governed learning + refine-soul button
- Phase 3a: web-api governed-learning handlers + LLM wiring
- Phase 3a: web RPC contracts + soul-split proposal helper
- Phase 3a: user-mode Expression evolution (CLI)
- Phase 3a: Living Soul schema foundation (Core/Expression/Learning Log)

Other commits · 26 `fix`, 2 `chore`, 2 `refactor`, 2 `test`, 1 `docs`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.18 {#v0-4-18}

Date · 2026-06-16
Commits · 2 since 0.4.17 (`git log --oneline --no-merges v0.4.17..v0.4.18`)

Other commits · 1 `chore`, 1 `fix`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.17 {#v0-4-17}

Date · 2026-06-16
Commits · 19 since 0.4.16 (`git log --oneline --no-merges v0.4.16..v0.4.17`)

Features (11)

- **web** · New Session opens a personality picker modal
- **desktop** · native error window + loading splash (DT1/DT3)
- gateway OS-service control plane + status pill (T8/DT4)
- complete T12 native capability ports
- **web** · bootstrap remote-mode RPC client on desktop
- **desktop** · delete forked renderer, SPA-always mode
- **web** · add ?mode=quickchat compact SPA route
- **web** · add desktop-only Settings sections + onboarding bridge restart
- **web-contracts** · add EthosDesktopBridge type + SPA desktop wrapper
- **desktop** · serve shared SPA via localhost + bootstrap in main process
- adding missing features in desktop app

Other commits · 4 `fix`, 2 `test`, 1 `chore`, 1 `style`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.16 {#v0-4-16}

Date · 2026-06-15
Commits · 26 since 0.4.15 (`git log --oneline --no-merges v0.4.15..v0.4.16`)

Features (6)

- phase 1 spine — registerCliSubcommand, /-autocomplete, personality diff, kanban identity stamp
- deliver goal completions to originating channel; misc provider/web-api fixes
- goal execution engine, autonomy/recovery, and journey-graph UX
- Wire goals into all surfaces — wiring, CLI, gateway, intake, graph, SSE
- Add Goals system — async personality-scoped agent runs
- implement mandatory feature gaps (3, 4, 5, 7, 8, 9, 10, 11, 12)

Other commits · 14 `fix`, 2 `style`, 2 `docs`, 1 `chore`, 1 `refactor`.

Breaking

- No commit in this range is marked breaking (`!`).

## 0.4.15 {#v0-4-15}

Date · 2026-06-09
Status · beta

- Mandatory feature gaps — nine cross-cutting capabilities (plugin commands, inline context, zero mode, admin panel, remote gateway, data sources, background notifications, environment-gated skills, skill evolver) land in a single release.
- Plugin extensibility reaches parity with built-in features — slash commands, data sources, and widget templates all surface through the same registries and RPCs that core uses.
- Zero mode (`ethos -z`) makes the agent composable in shell pipelines, CI, and git hooks without an interactive session.

Notable changes

- **Gap 3 — Plugin slash commands.** Plugins register slash commands via `api.registerSlashCommand()` that work across all surfaces (CLI, web, gateway, Telegram, Discord, Slack). Listed in `/help` with a `[plugin]` tag. Tab-completable in CLI.
- **Gap 4 — Inline context references (`@ref`).** `@file` and `@url` tokens in user messages are resolved and inlined before the LLM sees the prompt. Files truncated at 8,000 chars. Tab-completable in CLI, file picker in web composer.
- **Gap 5 — Zero mode.** `ethos -z "prompt"` runs a single prompt non-interactively, streams to stdout, exits. Composable with `--personality`, `--model`, `--session`, piped stdin.
- **Gap 7 — Web admin panel.** Admin RPC endpoints for managing MCP servers and system configuration. Gated by `adminEnabled` config flag. Admin URL printed on `ethos serve` startup.
- **Gap 8 — Desktop remote gateway.** Desktop app can connect to an Ethos server on another machine. CORS accepts `file://` and RFC 1918 private IP origins for Electron and LAN deployments.
- **Gap 9 — Plugin data sources with widget templates.** Plugins register read-only SQLite databases via `api.registerDataSource()` and declare widget templates in `widgets.yaml`. Widget template cards create pre-filled dashboard panels on click.
- **Gap 10 — Background job notifications.** Offline notification buffer in the gateway delivers `process_complete` notifications on the user's next turn when they were disconnected during job completion.
- **Gap 11 — Environment-gated skills.** Skills can declare environment requirements. `includeUnavailable` parameter added to the skills list RPC so the library can show gated skills with availability status.
- **Gap 12 — Skill evolver wiring.** End-to-end wiring of `@ethosagent/skill-evolver`: analyzes eval JSONL output, proposes skill rewrites and new skills, human approval queue in web and desktop UI, `ethos evolve` CLI command.

Breaking

- None.

---

> **Versions 0.2.8 -- 0.4.14** shipped incremental improvements including the web dashboard, desktop app, dashboard system, and design-token engine. Detailed entries for these versions are forthcoming.

---

## 0.2.7 {#v0-2-7}

Date · 2026-05-11
Status · beta

- Docs rewrite under the [`/docs` skill](https://github.com/ethosagent/ethos/blob/main/.agents/skills/docs/SKILL.md) (originally shipped as `DOCS.md` at the repo root) — two-persona shell ("Using Ethos" / "Building on Ethos"), Diátaxis four-pillar within each.
- Kanban [tool](getting-started/glossary.md#tool) for [personalities](getting-started/glossary.md#personality) that need to coordinate multi-step plans without leaning on the prompt.
- Theming and [skin](getting-started/glossary.md#skin) engine — per-user skins pinned in `~/.ethos/config.yaml`, single `@ethosagent/design-tokens` source of truth across TUI and Web.

Notable changes

- Authored the 18-page "Using Ethos" tree (~4,100 lines) covering quickstart, tutorials, how-tos, reference, and explanation.
- Added the `todo` tool for the agent's own task-tracking; enforces a single `in_progress` task at a time (`MULTIPLE_IN_PROGRESS` error code).
- Shipped a 10-skill coding [skill](getting-started/glossary.md#skill) bundle plus the Skills docs hub.
- Split the observability library from the Ethos vocabulary so non-Ethos surfaces can reuse the storage and retention machinery.
- Added a security-controls catalogue and addressed the pre-launch [audience boundary](getting-started/glossary.md#audience-boundary) gaps surfaced during the safety chapters.
- Pinned `pnpm` and tightened the safety-scanner's pre-install scan; gated empty `mcp_servers` blocks from passthrough.
- Switched the agent dev workflow to script-first CI with lefthook hooks and PR templates.
- [Telegram](platforms/telegram.md) gateway no longer crashes on a bad bot token — `Bot.start` rejections are caught and logged.
- Skin override propagates correctly from CLI personality setup and from the Web UI.

Breaking

- None at the public CLI surface. The internal `Skin` token shape under `@ethosagent/design-tokens` evolved; consumers should re-pin the workspace version.

## 0.2.6 {#v0-2-6}

Date · 2026-04-28
Status · beta

- In-process safety watcher and `InjectionClassifier` wired into the production [`AgentLoop`](getting-started/glossary.md#agent-loop).
- Universal always-deny filesystem floor with symlink-defeat for [`ScopedStorage`](getting-started/glossary.md#storage).
- SSRF defenses — scheme allowlist, per-personality net policy, redirect revalidation, policy-fingerprinted [session](getting-started/glossary.md#session) reuse.

Notable changes

- Added the `approvalMode` capability gate and an expanded hardline blocklist.
- Default-deny non-`http(s)` URLs in the browser route.
- Split `policyFingerprint` from the session map key so a forged key alone cannot bypass policy.
- Verified `session.policyFingerprint` instead of trusting the map; strict policy-keyed lookup everywhere.
- Documented the `approvalMode` capability gate as no-op-by-design today; the contract is locked.
- Worktree hook plus hard check on the `agent-sandbox` parent directory.

Breaking

- Sessions persisted before 0.2.6 lack a `policyFingerprint` and will be ignored under the new lookup. `/new` to start a fresh session.

## 0.2.5 {#v0-2-5}

Date · 2026-04-10
Status · beta

- Observability — [`@ethosagent/observability-sqlite`](https://github.com/ethosagent/ethos/tree/main/extensions/observability-sqlite) ships and is wired into the production `AgentLoop`.
- Wave B retention — `RetentionConfig`, `safety.observability` config, nightly prune cron, support-bundle export.
- Setup wizard — single-step re-entry, paste enabled on every token and key input, disabled-with-label state for unsupported providers.

Notable changes

- `ethos retention` and `ethos data` CLI commands.
- Support-bundle tar export and an `inspect` archive tier.
- Wave A observability foundation: store turn-level token usage, latency, and tool-call durations.
- `storeToolArgs: 'full'` redaction bypass for trusted operators.
- Onboarding wizard parity with the TUI; arrow-key direction fix on the launch-chat prompt.
- `Storage` abstraction completed in the data CLI surface; `--personality` is surfaced in the help output.
- Tail cursor starvation fix in the observability reader.

Breaking

- None.

## Upgrade notes {#upgrade-notes}

When moving between minor versions, follow this sequence:

1. Read the relevant section above for any **Breaking** entry.
2. Upgrade the CLI: `ethos upgrade`, or `ethos upgrade --version <version>` for a specific release. Both back up `~/.ethos` first and roll back if the new version fails `ethos doctor` — see [`ethos upgrade`](using/reference/cli.md#ethos-upgrade).
3. Verify the new version: `ethos --version`.
4. If the breaking notes call for a session reset, run `/new` in chat or remove `~/.ethos/sessions.db`.
5. If the breaking notes call for a config rewrite, run `ethos setup` — answers default to the existing values.

The patch stream (0.2.x → 0.2.y) does not change config schemas. Minor bumps (0.x → 0.y) may add fields with safe defaults; old configs continue to parse. Major bumps (0.x → 1.x, when they happen) will document migration steps inline above.

To check the current version programmatically:

```bash
cat /path/to/repo/VERSION
# or
ethos --version
```

## See also {#see-also}

- [Troubleshooting](troubleshooting.md) — error catalogue with Cause / Fix / Prevent per entry.
- [CLI reference](using/reference/cli.md) — every subcommand, flag, and exit code.
- [Glossary](getting-started/glossary.md) — every domain term in one place.
