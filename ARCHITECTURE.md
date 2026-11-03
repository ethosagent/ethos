Ethos — Architectural Constitution
==================================

> This document is the constitution of the Ethos framework. It defines the
> non-negotiable laws of the system's structure: dependency direction,
> extension boundaries, ownership of critical contracts, and the rules a
> validator mechanically enforces.
>
> This document is intentionally short, intentionally restrictive, and
> intentionally slow to change.

**What belongs here.** Laws. Principles. Invariants. Schemas. Governance.
Boundaries that, if violated, compromise the framework's identity.

**What does not belong here.** Implementation inventory, current state,
package examples, file paths that may move, debugging gotchas, migration
notes, operational how-tos. Those live in [AGENTS.md](./AGENTS.md) (working
manual), [CONTRIBUTING.md](./CONTRIBUTING.md) (process), and the operational
state sidecar that complements §IX.

If a fact would become wrong as the codebase evolves, it does not belong
in this document.

This document changes only by the procedure in §VI. No casual edits.

------------------------------------------------------------------------

## I. Immutable Principles

These five principles do not change by amendment. A change to this
section re-issues the constitution under a new major version; the
previous version remains the authority for code that has not migrated.

**P1 — Contracts before implementations.**
Every replaceable behaviour is defined as an interface before any
implementation of it exists. New behaviours are added by writing a
contract, then writing one or more implementations against the contract.
Never the reverse.

**P2 — Dependency direction is one-way.**
A module may depend on modules in layers below it, and on no module in a
layer above it. The direction is enforced mechanically; it is not a
stylistic preference.

**P3 — Composition is explicit.**
Concrete implementations are assembled in named composition roots,
nowhere else. Code never reaches for siblings, globals, or process
environment at use time.

**P4 — Personality is structure, not prose.**
A personality is a schema-bound component whose fields determine tool
access, memory scope, model routing, filesystem reach, and safety
policy. Personality is not a system prompt string and may not grant any
capability the schema does not express.

**P5 — Safety primitives are non-optional.**
Every inbound message, every outbound message, and every tool invocation
crosses a safety boundary. Removing the boundary, downgrading the
boundary, or routing around the boundary is not within the power of any
extension or app.

------------------------------------------------------------------------

## II. Runtime Boundary

The primary mental model.

```
                          ┌──────────┐
                          │   Apps   │      user-facing entry points
                          └────┬─────┘
                               │
              ┌────────────────▼──────────────────┐
              │              Wiring               │   composition roots
              └─────┬──────────┬──────────┬───────┘
                    │          │          │
      ┌─────────────▼───┐  ┌───▼────┐  ┌──▼─────────┐
      │ Security kernel │  │  Core  │  │ Extensions │
      └───────┬─────────┘  └───┬────┘  └─────┬──────┘
              │                │             │
            ┌─▼────────────────▼─────────────▼──┐
            │             Contracts             │   interfaces, zero
            └───────────────────────────────────┘   internal deps
```

**Security kernel** is the layer that implements the safety primitives
§V mandates. It depends on contracts only and imports nothing above
itself. Core does not import it at runtime: core consumes kernel
capability through injected contract types, and wiring is the layer that
binds an implementation to that seam. This is a restriction on core, not
a licence for anyone else — a kernel that core could import directly
would make the engine unswappable and the kernel unreplaceable.

Apps may carry their own thin wiring adapter, provided the shared
topology lives in `packages/wiring/` and the app adapter only adds
app-specific singletons.

Layer roles, the totality rule and the first-party rule: [ADR 0001](docs/decisions/0001-runtime-boundary-layers.md).

------------------------------------------------------------------------

## III. Architectural Laws

Each law is a one-sentence rule. Laws are binding. Each law names what enforces it: an archcheck rule id from
`architecture.config.ts` (§IX), a test, or "not mechanically enforced
(known gap)" — a law with no enforcer is recorded as a gap, never implied
to be checked. Rationale: Laws 1, 2, 3, 5 in [ADR 0002](docs/decisions/0002-law-rationale-dependency-direction.md); Laws 4, 7, 8 in [ADR 0003](docs/decisions/0003-law-rationale-extensions-storage-tools.md); Laws 6, 9, 10, 11 in [ADR 0004](docs/decisions/0004-law-rationale-schema-style-kernel.md).

### Law 1 — Contracts are pure
Modules in the contracts layer must not depend on any other internal
workspace package. External runtime dependencies are permitted only when
they author the schema language itself (zod, oRPC, Protobuf-TS).
*Enforced by:* archcheck `l1-contracts-pure` (the contracts layer may
import no internal layer; external packages sit outside the layer graph).

### Law 2 — Core does not import concrete implementations
The core layer imports contracts only. It does not import an LLM
provider, a tool, a memory backend, a session store, a platform adapter,
a persistence backend, or any extension that implements an injection
seam.
*Enforced by:* archcheck `l2-core-no-concrete` (core may import contracts
and the security kernel only) and
`packages/core/src/__tests__/no-kernel-runtime-imports.test.ts`. §II lets
core reach the kernel through contract types only, but archcheck's
`ignoreTypeOnly` is set per source layer, so the archcheck rule allows
every core → kernel edge; the test scans non-test `packages/core/src` for
runtime imports of the kernel packages (the `security-kernel` layer in
`architecture.config.ts`) and allows only `import type` / `export type`.

### Law 3 — Wiring is the only composition root
Only wiring modules import concrete extensions by name and assemble them.
*Enforced by:* archcheck `l3-wiring-composes` (wiring may import every
layer and owns the report for a file in no layer), with the deny side in
every other layer rule — `l5-apps-through-wiring`,
`extensions-implement-contracts`, `support-packages`,
`core-adapters-wrap-core` — and `app-entry-modules-compose` naming the
app wiring adapters §II permits.

### Law 4 — Extensions implement contracts
An extension is a replaceable module that implements one or more
contracts. Extensions may depend on sibling extensions. The §IV patterns
are guidance for healthy sibling dependencies, not validator-enforced
categories.
*Enforced by:* archcheck `extensions-implement-contracts` (an extension
never reaches wiring or apps; sibling extensions share a layer, so their
edges are allowed). That an extension implements a contract is not
mechanically enforced (known gap).

### Law 5 — Apps do not bypass wiring
An app imports wiring and contracts. An app does not import a concrete
extension directly.
*Enforced by:* archcheck `l5-apps-through-wiring` (runtime imports;
`import type` is exempt), `app-entry-modules-compose` (the entry modules
that are an app's thin wiring adapter) and `web-api-rpc-is-thin`.
Violations that predate archcheck are recorded in
`.archcheck/baseline.json`, which may only shrink.

### Law 6 — Personality is schema-bound
A personality's behaviour is fully determined by the fields of the
frozen personality schema. Code does not read personality identity from
prompt text, filename heuristics, or any unschematised source.
*Enforced by:* the schema half by
`packages/types/src/__tests__/personality-field-count.test.ts` (the
frozen field count). That no code reads identity from prompt text or
filenames is not mechanically enforced (known gap).

### Law 7 — Storage abstraction guards the personality boundary
Modules that read or write user-authored files on a personality's behalf
use the Storage contract. All other filesystem access — internal state,
logs, pidfiles, journals, database-driver files, system paths,
build-time tooling — may use raw `node:fs`.
*Enforced by:* `apps/ethos/src/__tests__/no-raw-fs.test.ts` (the raw
`node:fs` scan and its reasoned allowlist) and
`scripts/check-tool-imports.sh` (tool packages; runs at pre-push and in
CI's `architecture` job), not archcheck: archcheck
cannot ban a Node built-in import. archcheck
`p24-no-fsstorage-in-libraries` enforces the other half — library code
receives an injected Storage and never constructs `FsStorage` — over every
file archcheck reads (the root `tsconfig.json` program).
`packages/types/src/__tests__/storage-construction-boundary.test.ts`
covers the same boundary for library files outside that program, such as
`extensions/execution-pi/pi-extension/`.

### Law 8 — Tool execution respects the personality toolset
The tool registry filters tool definitions presented to the model by
personality toolset and rejects calls outside the allowlist at execution
time. Rejected calls produce typed error results that maintain the
model's message contract.
*Enforced by:* `packages/core/src/__tests__/tool-registry.test.ts`
(filtering at definition time and rejection at execution time).

### Law 9 — Imports are extensionless internally
Internal relative imports omit the file extension.
*Enforced by:* not mechanically enforced (known gap). No lint rule,
test or archcheck rule inspects import specifiers for an extension, and
tsx resolves both forms, so an extensioned import does not fail in dev.

### Law 10 — Library code is silent
Library code outside designated app entry points uses the `Logger`
contract for all output. `console.*` is permitted only in app entry
modules and in build/test tooling.
*Enforced by:* archcheck `l10-silent-libraries` over `packages/**` and
`extensions/**`, with named exceptions in `architecture.config.ts`.
`apps/**` is not scanned (not mechanically enforced there).

### Law 11 — Kernel guarantees are not weakenable from outside
A module outside the security kernel must not be able to weaken a
guarantee the kernel enforces.

Like §V, this law has no exception path under §VIII: an exception to it
is, by definition, a module that can weaken a kernel guarantee.

*Enforced by:* behaviourally, by the AgentSafety conformance suite
(`packages/core/src/__tests__/safety-conformance.test.ts`); there is no
static rule (known gap). Its no-exception-path half is enforced by the
`exceptions` check in `scripts/check-architecture.mjs`, which rejects a
sidecar entry naming Law 11.

------------------------------------------------------------------------

## IV. Extension Patterns

The patterns are operational guidance, not validator-enforced categories. A new pattern needs no amendment.

- Patterns A-D (wrapper, safety decoration, content bundle, protocol bridge): [ADR 0005](docs/decisions/0005-extension-patterns.md).
- "LLM Provider Authoring" (thin adapter over a transport): [ADR 0006](docs/decisions/0006-llm-provider-authoring.md).
- "Decision Provider Authoring" (typed answers, errors as data): [ADR 0007](docs/decisions/0007-decision-provider-authoring.md).
- Task guides: `docs/content/building/`.

------------------------------------------------------------------------

## V. Safety Constitution

These rules are absolute. They have no exception path. They predate any
feature and outlive any release. Amendments to this section follow §VI
structural-class rules.

Safety primitives, whether they sit in the security kernel or at a core
enforcement point, follow the same bump procedure as the engine itself;
breaking changes require the unanimous maintainer agreement that core
changes require.

**S1 — Tool allowlist is authoritative.**
The personality toolset is the sole authority on which tools the model
may invoke. Enforcement happens at both definition time (the model sees
only allowed tools) and execution time (the registry rejects disallowed
calls). No code path circumvents the allowlist.
*Enforced by:* `packages/core/src/__tests__/tool-registry.test.ts`. That
no code path circumvents the registry is not mechanically enforced
(known gap).

**S2 — Sandbox attestation is binding.**
A tool that executes untrusted code does so inside an attested sandbox.
The attestation declares confinement properties; the framework treats a
failed or absent attestation as untrusted and applies the strictest
classifier.

**S3 — Outbound deduplication is centralised.**
Outbound messages on every channel pass through a single deduplication
chokepoint keyed on session identity and message content; a reply is
keyed on the inbound message it answers as well. Channel adapters do not
implement their own deduplication. A duplicate is a silent drop.
*Enforced by:* the chokepoint by
`extensions/gateway/src/__tests__/dedup.test.ts`, and the reply key by
`extensions/gateway/src/__tests__/dedup-reply-scope.test.ts`. The ban on
adapter-local deduplication is not mechanically enforced (known gap).

*Amended 2026-09-28 (§VI class: Structural, as §V requires for any
amendment to this section).* The reply key gained the inbound message.
Rationale: keyed on session and content alone, a correct reply to a new
message was dropped whenever its text equalled the previous reply in the
same session inside the window (two requests both answered "Done."), and
the turn still counted as answered. With the inbound message in the key,
one reply is still never delivered twice, and two replies are never merged
into one. Every other outbound message keeps the session-and-content key.
The §IX `S3_outbound_dedup` rule changes in the same PR. No module becomes
non-compliant: the chokepoint and the ban on adapter-local deduplication
are unchanged, so no migration document is needed. Recorded in
`CHANGELOG.md`.

**S4 — Tool progress is internal by default.**
Progress events emitted by tools are framework-internal unless the tool
author explicitly opts an event into user visibility. The framework
never promotes an internal event to user visibility on a tool's behalf.

**S5 — Hooks enforce, they do not merely observe.**
A hook that asserts a precondition must prevent the gated action when
the precondition fails. Three execution models exist (parallel observer,
sequential modifier, sequential claimer). Preventing an action requires
the modifier or claimer model. Emitting an event without preventing the
action is a contract violation.

**S6 — Inbound text passes safety injection.**
Every inbound user message and every retrieved memory passes through the
safety injection pipeline before reaching the LLM. The pipeline is
reachable only through the safety seam injected into every agent loop;
no personality, channel, or tool may disable it, and no schema field may
exist whose effect is to disable it. A personality safety block may only
ever narrow what the framework already permits; a field that widens
policy is a violation of this rule, not a configuration of it.
*Enforced by:* `packages/types/src/__tests__/personality-field-count.test.ts`
(no schema field may be added without the drift gate moving) and the
AgentSafety conformance suite
(`packages/core/src/__tests__/safety-conformance.test.ts`).

**S7 — Boundary errors are user-facing.**
A boundary violation — storage scope, tool allowlist, sandbox
attestation, safety injection failure — surfaces as a typed error to
the operator. Silent failures are forbidden.

**S8 — Plugin contract compatibility is strict.**
A plugin declares the contract major version it was built against. The
loader rejects mismatches without overlap. *Rationale:* overlap
deprecation has, historically, become permanent compatibility.
*Enforced by:* `packages/plugin-contract/src/__tests__/plugin-contract.test.ts`
(`checkPluginContractMajor`).

**S9 — Secret values are stored exclusively in SecretsResolver.**
A secret value — API key, bearer token, OAuth token, password, or any
credential — must never be written to a config file, personality file,
MCP server config, export archive, or any storage path outside the
`SecretsResolver` interface. Config files may reference a secret by
name (for documentation or manifest purposes) but never by value.
`SecretsResolver` is the sole storage and retrieval path for all
credential material. No exception path exists for this rule.

S2, S4, S5, S7 and S9 are behavioural: tests exercise them, but no static
rule — archcheck or otherwise — enforces them (known gap). None of the
§V rules is an archcheck rule, and none takes an exception.

------------------------------------------------------------------------

## VI. Change Governance

This document changes only by the procedure below.

### Amendment classes

| Class | Examples | Approvals | Validator update | Notes |
|---|---|---|---|---|
| Editorial | typo, wording, broken link | 1 maintainer | none | No semantic change. |
| Clarifying | rephrasing a law without changing its scope | 1 maintainer | none | Owner of the affected contract must sign off. |
| Substantive | adding a law, narrowing a law, adding or expiring an exception, adding an extension pattern | 2 maintainers | required, same PR | CHANGELOG entry naming the class. |
| Structural | adding/removing a layer, changing the runtime boundary, adding a new contract type, changing a frozen-schema ownership | unanimous maintainer agreement, RFC | required, same PR | Migration note for non-compliant code. |
| Constitutional | any change to §I (Immutable Principles) | re-issue under a new constitution version | required, same PR | The previous version remains authoritative for unmigrated code. |
| Schema | adding/removing/renaming a field on a frozen schema | per §VII bump procedure for that schema | required | Mandatory schema drift gate update. |

### Required artefacts for substantive or larger amendments

1. A PR modifying this document.
2. A matching update to §IX rules with passing tests.
3. A CHANGELOG entry naming the amendment class.
4. A migration document when an existing module becomes non-compliant.

### Forbidden modifications

A modification that makes a law unenforceable — by removing its
validator rule without removing the law, by softening the rule's
phrasing to permit the violation, or by adding an exception broader than
a single named module — is itself a constitutional violation and is
treated as a §IX failure.

------------------------------------------------------------------------

## VII. Frozen Schemas

A frozen schema is a contract whose surface is governed beyond ordinary
type changes. Every frozen schema has:

- A canonical contract module.
- A mechanical drift gate (a counter, a constant, or an enumeration test).
- A named owner.
- A bump procedure.

The personality schema is the worked example. [Personality governance](docs/content/building/explanation/personality-governance.md) explains how its freeze rule and the generated character sheet operationalise this section for `PersonalityConfig` — the personality-alignment phase removed four non-identity fields (`skin`, `busyInputMode`, `verbosity`, `metadata`) under exactly the procedure below. [AgentCard governance](docs/content/building/explanation/agent-card-governance.md) explains why the A2A signed card — a peer verifies it once, out of band, and trusts that anchor from then on — needed the same mechanical treatment (added in the a2a-spec-compat phase, D14). [Decision provider governance](docs/content/building/explanation/decision-provider-governance.md) is the RFC that added the Decision provider contract as a new contract type (decision-provider-jev plan, M0).

### Roster

| Schema | Owner | Bump trigger | Drift gate kind |
|---|---|---|---|
| Personality schema | Any two repository maintainers | Adding, removing, or renaming a top-level field | Field-count file |
| Plugin contract | Plugin platform maintainers | Any breaking change to a field consumed by external plugin authors | Contract-major constant |
| LLM provider contract | LLM platform maintainers | A change to the streaming chunk union or the provider feature surface | Variant enumeration test |
| Hook execution model | Repository maintainers (unanimous) | Adding, removing, or renaming an execution model | Method-count test |
| Storage contract | Any two repository maintainers | A change to the error contract, the atomicity guarantees, or the boundary model | Method-shape test |
| Memory contract | Any two repository maintainers | Adding, removing, or renaming a method on `MemoryProvider` | Method-count test (`memory-method-count`) |
| Agent event union | Any two repository maintainers | Adding, removing, or renaming a variant | Variant enumeration test |
| Tool contract | Any two repository maintainers | A change that affects already-shipped tool packages | Shape test |
| Context engine contract | Any two repository maintainers | Adding, removing, or renaming a method on `ContextEngine` | Method-count test (`context-engine-method-count`) |
| Content-addressed store (ContentStore) | Any two repository maintainers | Adding, removing, or renaming a method on ContentStore | Method-count test |
| AgentCard (A2A signed card) | Any two repository maintainers | Adding, removing, or renaming a top-level field on `AgentCard` (`packages/types/src/a2a.ts`) | Field-count + field-name test (`agent-card-field-count`) |
| Pause lifecycle contract | Any two repository maintainers | Adding, removing, or renaming a method on `PauseLifecycle` | Method-count test (`pause-lifecycle-method-count`) |
| Decision provider contract | Any two repository maintainers | Adding, removing, or renaming a method on `DecisionProvider` (`packages/types/src/decision.ts`) | Method-count test (`decision-provider-method-count`) |

### Bump obligations

Bump obligations, worked examples for `ContextEngine` and `CompletionChunk`, and the categories that may never become frozen-schema fields: [ADR 0008](docs/decisions/0008-frozen-schema-bump-rules.md).

------------------------------------------------------------------------

## VIII. Exception Policy

No law in §III, §V, or §VII is overridden by a permanent exception. An
exception is a temporary, named, time-bounded carve-out.

### Required fields on every exception

| Field | Meaning |
|---|---|
| `id` | A stable identifier referenced by validator output. |
| `law` | The article and number of the law being suspended. |
| `scope` | The smallest path, module, or symbol the exception covers. |
| `reason` | A one-sentence explanation, including the cost of not granting it. |
| `owner` | A named maintainer responsible for removal. |
| `created` | The date the exception was opened (ISO-8601). |
| `removal_condition` | The observable condition that closes the exception. |
| `review_by` | The date by which the exception is re-justified or removed. |

### Forbidden exception shapes

- Indefinite exceptions ("until further notice", "TBD").
- Exceptions without a named owner.
- Exceptions whose `removal_condition` is "best effort" or otherwise
  unobservable.
- Exceptions to §V Safety Constitution rules. Safety rules are amended
  through §VI or not at all.
- Exceptions to §III Law 11. An exception permitting a module outside
  the security kernel to weaken a kernel guarantee is the violation the
  law names.
- Exceptions broader than a single named scope. A pattern-wide
  exception is a law change, not an exception.

### Expiry

An exception whose `review_by` date has passed without a renewal PR is
treated as expired. The validator surfaces expired exceptions as
violations. There is no automatic renewal. There is no
permanent-grandfather list anywhere in this constitution.

### Where exceptions live

Active exceptions are tracked outside this document. The constitution
defines the policy; one file holds each entry, never two.

- **Exceptions to a rule archcheck enforces** live in
  `architecture.config.ts` `exceptions:` and nowhere else.
- **Exceptions to a law another gate enforces** live in the operational
  state sidecar (`.architecture-state.yaml`), whose shape
  `scripts/check-architecture.mjs` checks against the fields above.

How the §VIII fields map onto an archcheck entry: [ADR 0009](docs/decisions/0009-archcheck-exception-field-mapping.md).

------------------------------------------------------------------------

## IX. Validator-Enforced Rules

This section says how the constitution is enforced. Two files carry the
mechanical projection, and neither restates the other.

### The operating model

- **`architecture.config.ts`** is the enforced projection of §II and of the §III laws readable from imports and syntax. archcheck checks it at pre-commit, at pre-push, in `pnpm test` (`packages/types/src/__tests__/archcheck.test.ts`, `archcheck-fixtures.test.ts`) and in CI's `architecture` job.
- **`.archcheck/baseline.json`** holds violations that predate archcheck. It only shrinks; `scripts/check-archcheck-baseline.mjs` fails growth.
- **Changing a rule, an exception or the baseline requires the maintainer's approval.** `scripts/guard-architecture.sh` blocks agent edits to the manifest and the baseline.
- **`scripts/check-architecture.mjs`** is the second checker. It reads the YAML block below and `.architecture-state.yaml`. It runs in `pnpm test` (`packages/types/src/__tests__/architecture-rules.test.ts`).

The full operating model and the 2026-09-26 amendment note: [ADR 0010](docs/decisions/0010-validator-operating-model.md).

What neither checker sees: `apps/web`, `apps/desktop` and
`apps/vscode-extension` are excluded from the root `tsconfig.json` that
archcheck reads, so no layer rule covers them (known gap).

### The archcheck rules

Generated from `architecture.config.ts` by `archcheck emit`. Do not edit
inside the fence: change the manifest and run `pnpm arch:emit`, or
`archcheck emit --check` fails.

<!-- archcheck:begin rules-table -->

**20 rules** · ✓ 18 deterministic · ◑ 2 proxy · ○ 0 judgement · **100% automatable**

| | Rule | Statement | Kind | Severity |
|---|---|---|---|---|
| ✓ | `app-entry-modules-compose` | an app entry module is its thin wiring adapter and may compose anything (§II) | layers | error |
| ✓ | `core-adapters-wrap-core` | plugin-sdk and agent-bridge wrap core for plugin authors and UI surfaces, and reach nothing concrete | layers | error |
| ✓ | `every-error-rule-has-a-fixture` | every error-severity rule has a fixture it catches | required-file | error |
| ✓ | `extensions-implement-contracts` | an extension implements contracts and never reaches wiring or apps | layers | error |
| ✓ | `kernel-reads-contracts` | the security kernel depends only on contracts and vendored shims | layers | error |
| ✓ | `l1-contracts-pure` | @ethosagent/types has zero imports and zero deps (§II L1) | layers | error |
| ✓ | `l10-silent-libraries` | library code does not write to the console (Law 10) | banned-syntax | error |
| ✓ | `l2-core-no-concrete` | core never imports concrete implementations (§II L2) | layers | error |
| ✓ | `l3-wiring-composes` | wiring is the composition root and may import every layer | layers | error |
| ✓ | `l5-apps-through-wiring` | apps depend on contracts and wiring only; concrete implementations come via wiring (Law 5) | layers | error |
| ✓ | `no-computed-dynamic-import` | dynamic imports name a literal specifier so the graph stays readable | banned-syntax | error |
| ✓ | `no-empty-catch` | a catch block handles, rethrows or explains the error it swallows | banned-syntax | error |
| ✓ | `observability-sqlite-stays-extractable` | observability-sqlite depends only on types, safety-redact and the sqlite shim, so it stays extractable | layers | error |
| ✓ | `p24-no-fsstorage-in-libraries` | library code receives an injected Storage and never constructs FsStorage (P2.4) | banned-syntax | error |
| ✓ | `support-packages` | library packages depend only on contracts, the kernel and vendored shims | layers | error |
| ◑ | `surface-throws-ethos-error` | CLI surface code throws EthosError, not raw Error (Phase 30.9) | banned-syntax | error |
| ✓ | `tests-reach-anything` | test files may import any layer to build fixtures | layers | error |
| ◑ | `tools-read-env-through-ctx` | tool code reads configuration through ctx.*, not process.env | banned-syntax | error |
| ✓ | `vendored-shim` | the sqlite shim is a thin platform wrapper with no Ethos semantics | layers | error |
| ✓ | `web-api-rpc-is-thin` | web-api rpc handlers validate input, call one service method and return its result | layers | error |

<!-- archcheck:end rules-table -->

### The validator block

The block below is read by `scripts/check-architecture.mjs` and by the
§VII drift gates. It keeps only what they read: the sidecar pointer, the
§V safety rules, the frozen schemas and the exception policy.

Where this section and the prose above conflict, the prose is
authoritative and the YAML is a bug to be fixed in the next amendment.

```yaml
# ARCHITECTURE-RULES v1
# Parser contract: a single YAML document inside the first ```yaml fence
# whose first non-blank line is `# ARCHITECTURE-RULES v1`.
# scripts/check-architecture.mjs reads this block plus
# `.architecture-state.yaml` and exits non-zero on any unmatched violation.
# The §VII drift gates read `frozen_schemas:`.

version: 1
state_sidecar: ".architecture-state.yaml"

# ---- Layers (§II) and laws (§III) -------------------------------------
# Not here. The layer table and the laws archcheck can read live in
# architecture.config.ts; each §III law names its enforcer in its own
# "Enforced by:" line.

# ---- Safety constitution (§V) ----------------------------------------
# These have no exception path. A violation here is a release blocker.

safety:
  S1_tool_allowlist:
    authority: personality.toolset
    enforcement: [definition_time, execution_time]
    bypass: forbidden

  S2_sandbox_attestation:
    failed_or_absent_attestation: treat_as_untrusted

  S3_outbound_dedup:
    chokepoint: single_gateway_module
    key: "(session_id, content_hash)"
    reply_key: "(session_id, content_hash, inbound_message_id)"
    adapter_local_dedup: forbidden

  S4_progress_audience:
    default: internal
    promotion: per_event_by_tool_author_only
    framework_promotion: forbidden

  S5_hook_enforcement:
    precondition_hook_model: [modifier, claimer]
    observation_only_model: parallel_observer

  S6_inbound_safety_injection:
    pipeline_position: before_llm
    reachable_only_via: injected_safety_seam
    opt_out: forbidden
    personality_safety_fields: narrowing_only
    # Mechanical: no schema field disables the pipeline, so the rule is
    # enforced by the personality drift gate, not by review.
    enforcement: mechanical

  S7_boundary_errors_surface:
    typed_error: required
    silent_failure: forbidden

  S8_plugin_contract_strict:
    overlap_deprecation: forbidden

  S9_secrets_in_resolver_only:
    rule: "Secret values must never be written outside SecretsResolver"
    checks:
      - "No McpServerConfig.headers contains a literal Authorization token value"
      - "No personality config file or export archive contains a secret value"
      - "SecretsResolver is the only write path for credentials"
    severity: error
    no_exception_path: true

# ---- Frozen schemas (§VII) -------------------------------------------
# Identities listed here; contract module paths live in the sidecar.

frozen_schemas:
  personality:
    owner_class: any_two_maintainers
    drift_gate: counter_file
    forbidden_field_categories:
      - voice_speech_audio
      - emotion_mood_sentiment
      - per_channel_display
      - templates_labels
      - capabilities_outside_toolset
    # §VI amendment, voice V1a (eng-review D2): ONE field is carved out of
    # voice_speech_audio. `voice` carries identity — TTS voice id, language→voice
    # map, tier preference, fast-lane model — on the reasoning that a deployment
    # chooses the voice PROVIDER while the personality chooses how it SOUNDS,
    # the same way it chooses its model. Voice modes, VAD tuning and per-channel
    # speech affordances remain forbidden, and the exception is closed at both
    # ends: `personality-field-count.test.ts` fails if a second speech/audio
    # field appears.
    granted_field_exceptions:
      - field: voice
        category: voice_speech_audio
        rationale: identity_not_setting
        granted_by: voice_v1a_amendment

  plugin_contract:
    owner_class: plugin_platform_maintainers
    drift_gate: contract_major_constant
    overlap_deprecation: forbidden

  llm_provider:
    owner_class: llm_platform_maintainers
    drift_gate: variant_enumeration_test
    # §VI Substantive amendment, openclaw-9.5-adoption item 7 (D31): the
    # `compaction` variant carries a provider-side compaction block out of the
    # provider so it can be round-tripped. `llm-provider-drift.test.ts` checks
    # the CompletionChunk union against BOTH its own list and this manifest.
    frozen_variant_count: 9
    frozen_variants: [text_delta, thinking_delta, tool_use_start, tool_use_delta, tool_use_end, usage, done, warning, compaction]

  hook_models:
    owner_class: maintainers_unanimous
    drift_gate: method_count_test

  storage:
    owner_class: any_two_maintainers
    drift_gate: method_shape_test

  agent_event:
    owner_class: any_two_maintainers
    drift_gate: variant_enumeration_test

  tool_contract:
    owner_class: any_two_maintainers
    drift_gate: shape_test

  memory_contract:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 5
    frozen_methods: [prefetch, read, search, sync, list]

  context_engine:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 3
    frozen_methods: [compact, shouldCompact, onTurnComplete]
    optional_method_addition: substantive
    required_method_addition: substantive_plus_plugin_contract_major

  content_store:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 4
    frozen_methods: [put, get, has, hash]

  pause_lifecycle:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 2
    frozen_methods: [readPauseOffset, signalReadyToSuspend]

  decision_provider:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 1
    frozen_methods: [decide]

  agent_card:
    owner_class: any_two_maintainers
    drift_gate: field_count_and_name_test
    frozen_field_count: 11
    frozen_fields: [id, name, description, protocolVersion, skills, endpoints, publicKey, keyFingerprint, signatureAlg, signature, did]

# ---- Exception policy (§VIII) ----------------------------------------
# Active exceptions live in architecture.config.ts (rules archcheck
# enforces) or the sidecar (everything else), not here. This block defines
# the shape every sidecar entry must take and the validator's failure modes.

exception_policy:
  required_fields: [id, law, scope, reason, owner, created, removal_condition, review_by]
  forbidden_shapes:
    - indefinite_term
    - missing_owner
    - unobservable_removal_condition
    - safety_constitution_carve_out
    - kernel_guarantee_carve_out
    - pattern_wide_scope
  expiry:
    on_review_by_passed: surface_as_violation
    automatic_renewal: false
  source: state_sidecar
```

------------------------------------------------------------------------

## Companion documents

This document is the constitution. The following documents complement it
and may be edited freely; they are not constitutional.

- [AGENTS.md](./AGENTS.md) / [CLAUDE.md](./CLAUDE.md) — working manual:
  conventions, gotchas, runtime quirks, and the "how to use this
  codebase" reference.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — process: PR conventions,
  schema-bump workflows, doc-sync rule.
- [DESIGN.md](./DESIGN.md) — visual and UX design system.
- [.agents/skills/docs/SKILL.md](./.agents/skills/docs/SKILL.md) — documentation information architecture (the `/docs` skill).
- [docs/decisions/README.md](./docs/decisions/README.md) — decision records: the rationale and extension-pattern prose moved out of this document.
- `architecture.config.ts` — the enforced projection of §II and §III
  that archcheck checks (§IX). Changes need the maintainer's approval.
- `.architecture-state.yaml` — the operational sidecar referenced from
  §IX: the tier roster, the register anchors, and the exceptions to laws
  archcheck does not enforce. Updated freely as the codebase evolves;
  never the authority on what is allowed, only on what currently exists.

If a question has no answer in this document, the answer is: the
constitution is silent, and the working manual or the codebase decides.
The constitution speaks only on the matters it speaks on.
