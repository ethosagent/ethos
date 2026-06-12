---
name: docs
description: |
  The Ethos docs system. Use whenever writing, editing, or restructuring any Ethos documentation — Docusaurus pages under docs/content/, the repo README, in-package READMEs, the agent-readable llms.txt, and the ETHOS.md shipped with each personality.
  Enforces page kinds (tutorial / how-to / reference / explanation / decision), front-matter contract, voice rules, anti-patterns, and the page-acceptance checklist. NOT for plan docs in plan/ (those follow their own conventions) or audit reports in plan/audits/ (those follow the security-audit skill). Invoke before any doc PR; flag any deviations during doc review.
---

# Ethos · Docs System

**The reader is in a hurry.** Every page earns its existence by serving one of four customer-first needs in the first screen. This system specifies the IA, page templates, voice, and acceptance rules that all Ethos documentation adheres to — across the Docusaurus site, the repo README, in-package READMEs, the agent-readable `llms.txt`, and every `ETHOS.md` shipped with a personality.

> Always read this skill before writing, editing, or restructuring any documentation. All page types, IA decisions, voice rules, and structural patterns live here. Do not deviate without explicit user approval. This is the docs counterpart to [DESIGN.md](../../../DESIGN.md) — same authority, same enforcement, same shape.

## Product context

- **What these docs cover:** Ethos — TypeScript AI agent framework where personality is architecture. CLI, channel adapters, plugin system, multiple LLM providers, persistent sessions.
- **Two audiences (the persona shell):**
  - **Using Ethos** — operators running the CLI, deploying personalities, wiring channels, configuring providers. Reads docs to *get something working*.
  - **Building on Ethos** — contributors writing tools, providers, personalities, channel adapters, plugins. Reads docs to *extend the framework*.
- **A third reader: AI agents.** Other coding agents (Claude Code, Cursor, OpenClaw, Hermes) consume Ethos docs to scaffold integrations. We ship `llms.txt` as a first-class artifact, not an afterthought.
- **Surface this lives on:** the canonical site is Docusaurus at [docs/](../../../docs/). The repo [README.md](../../../README.md), in-package READMEs, and `llms.txt` are derived surfaces that link back to the canonical pages.

## The four customer-first questions

Every page must serve at least one. A page that serves none gets cut.

| Question | What it means in practice |
|---|---|
| Can the reader **see the bigger picture**? | One-sentence pitch on the landing; "Architecture in 90 seconds" reachable from any page; mental model precedes mechanics. |
| Can the reader **understand the context**? | Why this exists, what problem it solves, which alternatives the reader was likely comparing it against. Linked from every concept page. |
| Can the reader **start using it just from this page**? | Quickstart from zero to first run in under 5 minutes (Using) / 10 minutes (Building). One command before any YAML. |
| Can the reader **get value quickly**? | Worked end-to-end examples that produce a visible win — a Telegram bot that replies, a research agent that summarizes a URL. Not toy snippets. |

These four questions are the **page-acceptance test**. A docs PR is reviewed against them before it is reviewed for prose quality.

## Information architecture

Two-persona shell at the top. Diátaxis four-pillar inside each persona. Shared concerns at the same level as the persona doors. One canonical tree — no parallel `/docs` vs `/kb` split, no orphan content trees.

```
docs/content/
  intro.md                          ← landing: one-sentence pitch + job grid + two doors
  getting-started/
    what-is-ethos.md                ← 90-second mental model (explanation)
    architecture-90-seconds.md      ← one diagram + three sentences each (explanation)
    why-ethos.md                    ← positioning vs LangChain/CrewAI/OpenClaw/Hermes (explanation)
    glossary.md                     ← every domain term in one place (reference)
  using/
    quickstart.md                   ← install → first chat in 5 min (tutorial)
    tutorials/                      ← learning-oriented walkthroughs
    how-to/                         ← task-oriented recipes
    reference/                      ← cli, config-yaml, personality-yaml, slash-commands
    explanation/                    ← what is a personality, memory model, sessions
  building/
    quickstart.md                   ← clone → run tests → ship a tool in 10 min (tutorial)
    tutorials/
    how-to/
    reference/                      ← interface specs: AgentEvent, Tool, LLMProvider, etc.
    explanation/                    ← personality-as-architecture, hook execution models, etc.
  platforms/                        ← shared: cli, telegram, discord, slack
  security/                         ← shared: overview, threat-model, controls, disclosure
  troubleshooting.md                ← error-index reference
  changelog.md
docs/static/llms.txt                ← agent-readable digest (generated)
```

**Rules of the tree:**
1. **One canonical home per page.** No page lives in two sections. If two audiences need it, it goes in `shared/` (platforms, security, troubleshooting) and both personas link to it.
2. **The persona shell is shallow.** Only the top nav splits by audience. Reference pages that genuinely serve both audiences live in `shared/`; they do *not* get duplicated into both persona trees.
3. **Diátaxis is enforced inside each persona.** Every page is exactly one of `tutorial`, `how-to`, `reference`, `explanation`, or `decision`. Mixed pages are a bug.
4. **Verb-driven section names within each persona.** Use `tutorials/`, `how-to/`, `reference/`, `explanation/` literally — don't rename them. Consistency is more valuable than cleverness. Decision pages sit at the top of a job cluster (or as a category index page), named for the job.
5. **No stub pages.** A page is either complete or doesn't exist. Stubs rot fastest and damage trust most.
6. **Jobs before personas on the landing.** The landing leads with an outcome grid — links phrased as jobs the reader would say out loud ("Ship a Telegram research assistant," "Automate code review," "Run a team on a kanban board") — *above* the persona doors. A newcomer knows their job before they know our vocabulary; the job grid converts job → path without requiring it. Section index pages follow the same rule: one value sentence, then an outcome-phrased directory; mechanics deferred one click.

## Page types

Every page declares `kind` in front-matter. The page must follow its kind's template — no exceptions.

| `kind` | Reader state | Purpose | Length | Required sections | Prohibited |
|---|---|---|---|---|---|
| `tutorial` | At study — learning Ethos for the first time | Acquire basic competence on one path | 300–700 lines | Goal · Prereqs · Estimated time · Numbered steps · **Try it** (observable success + one deliberate failure) · What you learned · Next step | Branching choices, alternative paths, "see also for advanced," design rationale |
| `how-to` | At work — has a real task to ship | Accomplish a specific outcome | 100–300 lines | Task statement (1 line) · Result statement (1 line) · Prereqs · Numbered steps · Verify · Troubleshoot | Concept teaching, "what is X" preambles, narrative arc |
| `reference` | At work — looking up a fact | Authoritative lookup, scannable | 100–500 lines | Synopsis · Parameters/fields table · Examples · Source path link · See also | Step-by-step narrative, opinions, marketing copy, design rationale |
| `explanation` | At study — building mental model | Answer one "why" question | 150–400 lines | Question (as H1) · Context · Discussion · Trade-offs · See also | Numbered steps, "how to" procedures, exhaustive parameter lists |
| `decision` | At a crossroads — knows the job, not the path | Route one job to the right approach tier | 100–250 lines | Job statement (one outcome sentence) · Effort ladder (each option labeled, exactly one "(Recommended)") · Trade-off table · "Choose otherwise when…" · Links into each path's tutorial/how-to | Teaching mechanics, neutral option lists with no recommendation, numbered implementation steps |

**Decision pages (the Stripe pattern).** The same job often has multiple legitimate approaches at different effort tiers — for Ethos, typically *built-in personality (no code)* → *custom personality YAML (low code)* → *plugin/interfaces (full API)*. A decision page presents the ladder with effort labels in the link text itself ("(No code)", "(Recommended)"), a trade-off table (rows = capabilities like memory scoping, custom tools, channel support; columns = the tiers, marking what's built-in vs build-it-yourself), and one opinionated recommendation in prose. Decision pages sit at the top of a job cluster and may serve as category index pages. Diátaxis organizes knowledge; decision pages organize *the choice* — both are needed.

**Tutorial vs. how-to test.** If the reader is *studying Ethos*, it's a tutorial. If the reader is *shipping something with Ethos*, it's a how-to. Pick one. A page that fails this test gets split.

**Explanation guardrails:**
1. **H1 is a "why" question.** "Why are hooks split into three execution models?" "Why is personality a structural component, not a system prompt?" If you can't phrase it as a why, the content belongs in reference or how-to.
2. **No procedures.** If a page has numbered steps, it has migrated to how-to.
3. **Cross-link instead of duplicate.** Explanation links to reference for "what's the signature?" and to how-to for "how do I use this?"

**Reference guardrails:**
1. **Every reference page links to its source-of-truth code path.** A `Tool` interface reference page links to [packages/types/src/index.ts](../../../packages/types/src/index.ts).
2. **Tables, not prose.** Parameters/fields are tables. Prose between tables is one sentence max.
3. **No rationale.** "We did it this way because…" lives in explanation. Cross-link.

## Front-matter contract

Every page starts with this front-matter block. CI will fail the build if any required field is missing or malformed.

```yaml
---
title: <Sentence-case page title>
description: <≤155 chars — what the page is, not advocacy for it>
kind: tutorial | how-to | reference | explanation
audience: user | developer | shared
slug: <optional kebab-case URL slug; defaults from filename>
agent: <optional bool; default true; opt-out from llms.txt + llms-full.txt>
time: <only on tutorials and how-tos — e.g., "5 min", "20 min">
updated: <YYYY-MM-DD, the last meaningful content change>
---
```

- `title` — the H1 derives from this; do not write a separate `# Heading` in the body.
- `description` — the source of truth for `<meta description>`, OG card, Twitter card, AI answer snippets, and sidebar tooltip. States *what the page is*, not *why you should read it*. Marketing voice fails the SEO/AEO scan.
- `kind` — must match the template the page follows. CI grep-checks for required and prohibited sections per kind.
- `audience` — `user` lives under `using/`, `developer` under `building/`, `shared` under `getting-started/`, `platforms/`, `security/`, `troubleshooting.md`, or `glossary.md`. The directory and the field must agree.
- `slug` — kebab-case, ≤4 words, semantically dense. Defaults from filename when omitted. Once published, slugs do not change — if one must, ship a permanent redirect in the same PR.
- `agent` — defaults `true`. Set `false` to exclude the page from `llms.txt` and `llms-full.txt`. Almost no page should opt out; the lever exists for sensitive or in-flux content only.
- `time` — present-tense, conservative estimate. Better to under-promise.
- `updated` — bumped on any content edit. Cosmetic-only edits (typos) do not bump it.

## Voice

The reader is a competent developer in a hurry — *and* a human deciding whether to invest the next five minutes. **Lead with value, then precision.** The mix shifts by page kind (see [Voice mode by page kind](#voice-mode-by-page-kind) below), but every page earns its first paragraph by answering one question: *why should I keep reading?*

This is a deliberate posture for the current product stage. Marketing voice is the key aspect now — readers must see the value before they invest in the mechanics. As Ethos matures and the user base grows, the balance may shift back toward precision-first; until then, value-first is the discipline. The skill itself is the place to rebalance — not individual pages.

Inherits DESIGN.md voice rules where they don't conflict with the rules below.

- **Imperative second person, when giving instructions.** "Run `ethos chat`." Not "We run `ethos chat`" or "You can run `ethos chat`." Landing-page or explanation openings can use other voices ("You wouldn't hire one person to be your engineer and your researcher…") — switch to imperative the moment the page turns procedural.
- **Marketing voice is allowed where it earns its place.** Concrete value claims, light-touch analogies, "you wouldn't X — why pretend Y?" structures, and CTA-shaped paragraph endings are welcome on landing pages, tutorial openers, explanation pages, and READMEs. The rule is *not* "no marketing" — it is "no hollow marketing." `A team of AI specialists that remember you across Slack and Telegram` earns its place. `Unleash the power of next-generation AI` does not. **The test:** replace the marketing word with a concrete fact; if nothing substitutes, the sentence carried no information.
- **Hollow advocacy is still slop.** Banned regardless of page kind: "unleash," "harness the power of," "supercharge," "revolutionary," "world-class," "next-generation," "10x," "AI-powered" as a header by itself, "Welcome to X!", "Get started" as a verb-less header. Buttons are verbs: "Install", "Run", "Configure".
- **No emoji as decoration.** Status indicators (✓ / ✗ / ⏳) only, and only where they convey state. Never in headings.
- **Concrete over abstract.** "API key invalid — re-enter to continue." Not "Authentication failed."
- **Specific identifiers.** In technical sections, reference real file paths, real function names, real config keys. Avoid "the foo system" when "[tool-registry.ts](../../../packages/core/src/tool-registry.ts)" is what you mean. (Landing/value paragraphs may stay abstract — but the body must get specific.)
- **No throat-clearing.** Drop "In this guide, we will…", "Note that…", "It's important to remember that…" Start with the value (landing/tutorial openers) or the goal (how-to/reference).
- **One thought per paragraph.** Paragraphs over six lines get split. The reader is scanning.
- **One instruction per sentence.** "Run `ethos chat`. Then send a message." Not "Run `ethos chat` and then, once it has started and you've confirmed the provider is configured, send a message." Compound instructions hide steps.
- **Condition before instruction.** "If the session was interrupted, re-run `ethos chat --resume`." Not "Re-run `ethos chat --resume` if the session was interrupted." Readers skip inapplicable sentences at the comma instead of after acting.
- **Active over passive.** "AgentLoop emits events." Not "Events are emitted by AgentLoop."
- **Sentence-case headings.** "Add a new LLM provider," not "Add A New LLM Provider."
- **Name the recommended path.** When a page presents more than one way to do the same job, it names exactly one "(Recommended)" and says why in one sentence. Neutral option lists make the reader do our thinking.

## Voice mode by page kind

The right voice depends on what the reader needs from the page. Choose by `kind` and surface:

| Surface or page kind | Lead (~first paragraph) | Body |
|---|---|---|
| Landing pages — `intro.md`, both quickstart entries | **Marketing.** Value-first, analogy-friendly, CTA-shaped. | Marketing tone preserved, with concrete specifics. |
| `tutorial` | **Goal + value.** "In five minutes you'll have a Telegram bot that remembers you." | Precise step-by-step. Imperative. |
| `how-to` | **Task + outcome.** "Add a new LLM provider and verify it streams." | Precise, no narrative. Imperative. |
| `reference` | **Synopsis.** One sentence of *what the thing is*. No advocacy. | **Precision throughout. Marketing voice fails here.** Lookup pages need scannable accuracy, not pitch. |
| `explanation` | **Question + value.** Restate why this matters to the reader before answering the why. | Argumentative, precise. |
| `decision` | **Job + promise.** "Run an agent on Telegram — three ways, pick by how much you want to own." | Opinionated, comparative. One "(Recommended)" named, trade-offs honest. |
| Repo `README.md`, per-package READMEs | **Marketing.** Standalone-readable; assume the reader may never click through to docs. | Marketing tone preserved, with concrete specifics. See [Cross-surface rendering](#cross-surface-rendering). |
| Personality `ETHOS.md` | **First-person identity statement.** A reader should be able to predict the personality's behaviour from the opening line. | Imperative, specific. |
| Front-matter `description` field | **Always informative, never advocacy.** This field surfaces in Google snippets and AI answer cards — marketing voice reads as spam there regardless of how the page body opens. |

The shift between lead and body is a *real* transition. A tutorial's first paragraph can read like landing copy — paragraph two is `npm i -g @ethosagent/cli`. Both belong on the same page.

## Cross-page rules

1. **Glossary-first-use: gloss inline, then link.** The first occurrence of any domain term (`personality`, `skill`, `tool`, `hook`, `mesh`, `session`, `memory scope`, `audience boundary`) on a page gets BOTH a parenthetical plain-English gloss and the glossary link: "every [personality](glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) declares…". The reader never leaves the sentence to understand it; the link exists for depth, not for comprehension. Glosses are one clause, not a second definition — the glossary stays canonical.
2. **Source-of-truth linking.** Every reference page links to the source file it describes — `Tool` reference → [packages/types/src/index.ts](../../../packages/types/src/index.ts). Code drift is detected when these links break.
3. **"See also" footer is mandatory** on every reference and explanation page. At least one link, no more than five. Curated, not auto-generated.
4. **"Recommended reading order" footer** on architecture and concept-cluster pages — Hermes-style — names the next 2–3 pages to read in order.
5. **Internal links use repo-relative paths**, not absolute URLs. `[Tool reference](../reference/tool.md)`, not the deployed `https://docs.ethos.dev/...` URL.
6. **Code samples are runnable.** Snippets compile against the current version of `@ethosagent/types`. Pseudocode is banned in reference; allowed in explanation only when labeled `// illustration`.
7. **One H1 per page.** Subsections are H2 and H3 only. Never skip levels (no H4 directly under H2).
8. **Tables for ≥3 parallel items.** Lists of properties, parameters, options, or trade-offs go in tables. Prose lists are allowed for ≤2 items.
9. **Every command shows its expected output.** In tutorials and how-tos, a command block is followed by an output block (or the relevant excerpt) showing what success looks like. "It printed something — was that right?" is a question the page must answer, not the reader.
10. **Placeholder grammar.** Values the reader must substitute use `<angle-bracket-kebab>` form (`<your-bot-token>`, `<personality-id>`) — one convention everywhere. Prefer zero-edit blocks over placeholders where possible: have the reader run a generator first (`ethos config print`, `ethos personality init`) so subsequent copy-paste blocks need no edits. A block the reader must hand-edit is where tutorials die.
11. **Tutorials fail on purpose, once.** Every tutorial's "Try it" block includes one deliberate failure the reader triggers and recognizes (a tool call outside the toolset, a `--dry-run`, a missing API key) — so the first real error they meet in production is one they've already seen with a calm explanation next to it.

## Reference schemas

Each kind of reference page follows a fixed schema. Schemas exist so the reader's eye knows where to look, page after page.

### CLI subcommand reference

```
## ethos <subcommand>

Synopsis · one-line description · since version
| Arg / flag | Type | Default | Description |
Examples · 1–3 minimal invocations
Exit codes · table of (code, meaning)
See also · related subcommands
```

### Config field reference (`config-yaml.md`, `personality-yaml.md`)

```
## <field-name>

Type · Default · Required · Since version
Description (1 paragraph max)
Example (1 minimal YAML block)
Notes (only if non-obvious behavior; one bullet per note)
```

### Interface reference (`AgentEvent`, `Tool`, `LLMProvider`, etc.)

```
## <InterfaceName>

Source · link to packages/types/src/<file>
Signature · TypeScript block, verbatim from source
Members · table of (name, type, description)
Notes · one bullet per non-obvious invariant
Used by · table of (consumer file, role)
See also · related interfaces
```

**Reference depth rules (apply to all reference schemas):**
1. **Constraints live in the description, in prose.** "Max 50; values above are clamped." "Only honored when `approvalMode: smart`." "Mutually exclusive with `model`." A type column without constraints is half a reference.
2. **Every enum value gets a one-line meaning, with the default marked.** Not `mode: 'keyword' | 'semantic' | 'hybrid'` alone — a list: `keyword` — FTS5 match (default); `semantic` — embedding similarity; `hybrid` — both, merged by score.
3. **Reference ↔ guide cross-links run both directions.** A parameter description links to the explanation/how-to that uses it ("see [approval gates](../how-to/set-up-approval-gates.md)"); the guide links back to the parameter's anchor. The reference answers "what"; one click answers "when and why".

### Error / troubleshooting entry

```
## <Error message or symptom>

Cause · 1–2 sentences
Fix · numbered steps (≤5)
Prevent · 1 bullet (optional)
```

## Anti-patterns

These patterns are slop. Code review checks for them, and so does CI grep where possible.

| Pattern | Why it's slop | Replacement |
|---|---|---|
| "Welcome to Ethos!" / "In this guide, we will…" | Throat-clearing burns the first screen | One-sentence pitch or task statement |
| Mixed-audience page (user + developer in one tree) | Both readers bounce off material for the other | Split by persona; share via `shared/` directory |
| Numbered steps inside an Explanation page | Page is secretly a how-to in costume | Move steps to how-to, cross-link from explanation |
| Rationale paragraphs inside Reference | Page is secretly an explanation | Move "why" to explanation, cross-link from reference |
| Stub pages (under-length, "TODO," placeholders) | Damages trust more than absence | Delete or fold until the page can be complete |
| "Click here" / "Read more" link text | Unscannable; screen-reader hostile | Linkify the noun phrase: "the [Tool reference](#)" |
| Marketing-template hero (3-column grid of icons in colored circles) | Indistinguishable from every AI SaaS | Stacked rows with real sample content |
| Hollow hero copy ("Build powerful agents," "Unleash AI," "World-class platform") | No information density; reader can't tell what the product does or who it's for | Specific value claim with a concrete artifact ("A team of AI specialists that remember you across Slack and Telegram") |
| Page opens with mechanics before value | Reader bounces before reaching the why | Lead with what the reader gets; mechanics in paragraph two. The lead → body transition is *the* shape of a well-written page. |
| Sidebar as primary discovery (no landing card grid) | Long sidebars defeat scanning | Card-grid landing + sidebar as secondary |
| Two parallel doc trees (`/docs` + `/kb`) | Reader searches twice | One canonical tree, types declared in front-matter |
| Auto-generated "See also" link dumps | Untrusted, noisy | Curated, ≤5 links, each one chosen |
| Emoji as decoration in headings (🚀, ✨, 🔥) | Indistinguishable from low-effort AI output | Status indicators in body content only |
| Repeated explanations of the same concept across pages | Drift bait — the second copy will lag | Single canonical page, link to it from everywhere else |
| Code samples with `// ...` placeholder bodies | Reader can't run it | Real, minimal, runnable code |
| "Coming soon" / "WIP" badges | Promises that rot | Ship the page or don't link to it |
| Missing `description` front-matter | Search engines invent a snippet from page body; AI answer cards do the same. Both lose. | Required field. CI fails the build if absent or over 155 chars. |
| Marketing-voice `description` ("Learn how to harness…") | The description is what surfaces in search results and AI answers — advocacy reads as spam | State what the page *is*, not why to read it |
| Auto-generated anchors on reference + glossary pages | Heading-text edits silently break external citations; agents that cited `#tools` lose the link when "Tools" is renamed | Explicit `{#stable-id}` suffix on every H2/H3 in reference + glossary |
| Neutral option lists ("you can use A, B, or C") | The reader came for a decision and got a menu; we made them do our thinking | Name one "(Recommended)" with a one-sentence why; honest trade-off table for the rest |
| Command block with no expected output | Reader can't tell success from failure; "it printed something" is not verification | Follow every command with what success looks like (output block or excerpt) |
| Tutorial that only ever succeeds | The reader's first error arrives in production, alone | "Try it" block includes one deliberate, explained failure |

## Page-acceptance checklist

A docs PR is not merge-ready until every changed page passes this list. Reviewers paste it into the PR.

- [ ] Front-matter declares `kind`, `audience`, and `updated`; values agree with the directory.
- [ ] Page matches the template for its `kind` (required sections present, prohibited sections absent).
- [ ] Passes the tutorial-vs-how-to test (or the why-question test for explanation).
- [ ] Answers at least one of the four customer-first questions and the answer is visible above the fold.
- [ ] **Opens with user-readable value.** Paragraph 1 is understandable to a reader who hasn't installed Ethos yet. Mechanics come no earlier than paragraph 2 (landing, tutorial, explanation) or after the synopsis (reference / how-to).
- [ ] **Voice mode matches the page's `kind`** per the [Voice mode by page kind](#voice-mode-by-page-kind) table. No marketing voice on reference pages; no mechanics-first opening on landing or tutorial pages; `description` front-matter is always informative, never advocacy.
- [ ] First occurrence of every domain term carries an inline plain-English gloss AND links to [glossary.md](../../../docs/content/getting-started/glossary.md).
- [ ] Every command in a tutorial/how-to is followed by its expected output; tutorials include the "Try it" block with one deliberate failure.
- [ ] Pages presenting multiple approaches name exactly one "(Recommended)"; decision pages carry the trade-off table.
- [ ] Reference pages link to source-of-truth code path; enum values have per-value meanings with the default marked; parameters state constraints in prose.
- [ ] "See also" footer present on reference and explanation pages (≥1, ≤5 links).
- [ ] Code samples are runnable against current `@ethosagent/types`.
- [ ] No anti-patterns from the table above.
- [ ] Docusaurus build passes with `onBrokenLinks: 'throw'`.
- [ ] Page is reachable from at least one other page (no orphans).

## Cross-surface rendering

Same content, different surfaces. Single source of truth is the markdown under [docs/content/](../../../docs/content/).

| Surface | What it shows | Render rule |
|---|---|---|
| **Docusaurus site** (primary) | Full tree, all kinds, full styling | The canonical surface. Other surfaces link back here. |
| **Repo [README.md](../../../README.md)** | Standalone-readable surface for users who may never click through. Marketing voice welcome; value-first opening required. Includes install, getting started, surface comparison, migration. | Treat as its own artifact, not as a docs index. Sections that overlap docs (Getting started, CLI vs chat, migration walkthroughs) are intentional — duplication is the feature here, not a bug. The reader of `README.md` may never see the docs site; they should still understand most of the product. |
| **In-package READMEs** | One-sentence purpose · install · link to package's reference page | One paragraph max. Package metadata, not docs. |
| **`docs/static/llms.txt`** | Glossary · CLI reference · interface reference · explanation pages | Generated at build time from pages with `agent: true` front-matter flag (or by kind: reference + explanation). Single text file, no nav. |
| **Personality `ETHOS.md`** | First-person identity for the personality itself | Not user docs — runtime config the agent reads. First-person, imperative, terminal-adjacent. **Not a marketing surface** (the LLM reads this at runtime; advocacy doesn't help there). See the ETHOS.md row in [Voice mode by page kind](#voice-mode-by-page-kind). |
| **`apps/web` in-app help** | Glossary tooltips, command-palette descriptions | Reads from canonical glossary entries. Sentence-length cap: 140 chars. |

## SEO and AEO

Docs reach humans through search engines and agents through LLM gateways. Both readers consume the same content, surfaced differently. SEO (Search Engine Optimization) and AEO (Answer Engine Optimization — how AI agents understand and cite the docs) are not afterthoughts: for an AI agent framework specifically, AEO is as load-bearing as SEO.

### URL slugs and anchor stability

1. **Slugs are kebab-case, ≤4 words, semantically dense.** `add-an-llm-provider`, not `adding-providers` or `llm-provider-tutorial`. Once published, slugs do not change. If a slug must change, the old URL gets a permanent redirect in the same PR.
2. **H2/H3 anchors are explicit on reference and glossary pages.** Write `## ToolResult {#tool-result}` so external citations survive heading-text edits. Tutorial / how-to / explanation pages may use auto-generated anchors.
3. **One H1 per page** (also a Diátaxis rule). Search engines and AI gateways alike treat H1 as the page topic.

### Required meta description

Every page declares `description` in front-matter (≤155 chars, no marketing voice). The same string surfaces in:

- Google search result snippets
- AI answer cards (Claude, Perplexity, ChatGPT Search, Google AI Mode)
- Social card previews (Twitter, Slack, Discord, LinkedIn)
- Sidebar tooltip on hover

A description states *what the page is*. "Step-by-step build of a Telegram bot using Ethos, from bot token to first reply in production." Not "Learn how to harness the power of Ethos to build amazing Telegram bots."

### Structured data (Schema.org JSON-LD)

Docusaurus injects JSON-LD per page, keyed by `kind`:

| `kind` | Schema.org type | Why |
|---|---|---|
| `tutorial` | `HowTo` | Tutorials show as step-by-step rich results; agents emit "follow these steps" answers |
| `how-to` | `HowTo` | Same. AI gateways prefer pages that declare their procedural shape. |
| `reference` | `TechArticle` | Lookup pages get clean preview cards; AI snippets quote the parameter table |
| `explanation` | `TechArticle` | Concept pages get article treatment, not procedural treatment |
| `decision` | `TechArticle` | Comparison/router pages get article treatment; the trade-off table is the quotable artifact |
| Troubleshooting entries | `FAQPage` (one Q&A per entry) | Each error becomes a discoverable Q&A on Google + in AI answers |

Sitemap (`sitemap.xml`) auto-generated by Docusaurus; submitted to Search Console after launch.

### Crawler policy

`docs/static/robots.txt` allows every major crawler — including AI gateways. Ethos is open-source; we want all gateways indexing.

Explicitly allowed: `Googlebot`, `Bingbot`, `GPTBot`, `ClaudeBot`, `Claude-Web`, `anthropic-ai`, `PerplexityBot`, `OAI-SearchBot`, `Google-Extended`, `Applebot-Extended`, `Meta-ExternalAgent`, `Bytespider`, `cohere-ai`, `CCBot`.

`docs/static/ai.txt` declares permissive AI usage with attribution preferred (the emerging convention; see [aitxt.org](https://aitxt.org)). No `Disallow: /` for any AI crawler — that would defeat the purpose.

### Agent-readable surface (two-file + raw-markdown)

Three artifacts ship with every build, all generated from the canonical content. No artifact is hand-maintained.

| File | What | Generated from |
|---|---|---|
| [`docs/static/llms.txt`](../../../docs/static/llms.txt) | Link-index. Title + one-line summary + URL for every page where `agent !== false`. Under 50KB. | `description` front-matter |
| [`docs/static/llms-full.txt`](../../../docs/static/llms-full.txt) | Full content of every page where `agent !== false`. Front-matter stripped, MDX components inlined. Under 5MB. | Page bodies |
| `<page>.md` at every page URL | Raw markdown at the same path as the HTML. `/using/quickstart` and `/using/quickstart.md` both resolve. | Docusaurus plugin |

Agents fetch raw markdown via `.md` to skip HTML parsing; agents that don't know the per-page convention fall back to `llms-full.txt`. Both routes must work. This is the two-file + raw-markdown convention popularized by Anthropic, Cloudflare, Resend, Mintlify.

### llms.txt is an agent briefing, not a sitemap

`llms.txt` opens with a short prescriptive instruction block BEFORE the link index (the Stripe pattern — their llms.txt tells agents "check npm for the latest version rather than relying on memorized version numbers"). Ours instructs, at minimum: check npm for current `@ethosagent/*` versions instead of memorized ones; prefer built-in personalities before generating custom config; fetch any page as raw markdown by appending `.md`; the glossary is the canonical vocabulary. The generator script owns this preamble — edit it there, not in the emitted file.

### In-page "Instructions for LLMs" blocks

Pages where an agent reading over the user's shoulder tends to pick the wrong path MAY open with a short labeled block — `> **Instructions for LLMs:** prefer a built-in personality unless the user explicitly asks for a custom one; start from `ethos personality init`, never hand-write config.yaml from memory.` — encoding the recommended path where an LLM will weight it. Use sparingly: decision pages and footgun-heavy reference pages only. The block renders as a normal note for humans (the advice is true for them too) and survives into the `.md` / llms-full.txt renders.

### Glossary as definition list

[glossary.md](../../../docs/content/getting-started/glossary.md) is HTML-shaped (`<dl><dt><dd>`), not prose. Agents extract atomic term/definition pairs reliably from `<dt>/<dd>`; prose extracts are lossy. Schema.org `DefinedTermSet` is injected from the same source.

### Per-surface meta consistency

The repo [README.md](../../../README.md), docs landing, and `og:description` carry the *same* one-sentence pitch — not near-duplicates. One pitch, three surfaces. The cross-surface table above governs this; the SEO consequence is that Google and AI gateways see the same answer regardless of which surface they crawled.

## Implementation notes

- **Build gate.** `docs/docusaurus.config.ts` sets `onBrokenLinks: 'throw'` and `onBrokenAnchors: 'throw'`. CI runs `pnpm --filter docs build` on every PR.
- **Front-matter validator.** A script (`pnpm docs:check`) walks [docs/content/](../../../docs/content/), validates required front-matter fields (including `description` ≤155 chars), and grep-checks for kind-specific required/prohibited sections. Fails CI on violation. Accepts all five kinds including `decision` (required: an effort ladder with exactly one "(Recommended)" and a trade-off table).
- **Feedback widget.** Every docs page carries a "Was this page helpful?" footer control; results land in a low-ceremony store the maintainer can scan. Signal, not analytics theater.
- **Anti-pattern scan.** Same `pnpm docs:check` greps for the worst patterns ("Welcome to Ethos", emoji in headings, "click here", stub-length pages, marketing-voice descriptions, missing stable anchors on reference + glossary pages). Easy wins, mechanical.
- **Sitemap, structured data, social cards.** Docusaurus' built-in sitemap plugin emits `sitemap.xml`. A small plugin injects Schema.org JSON-LD per page based on `kind`. A social-card plugin renders OG/Twitter card images from `title` + `description`.
- **Crawler files.** `docs/static/robots.txt` allows all crawlers including AI gateways. `docs/static/ai.txt` declares permissive AI usage with attribution preferred.
- **Agent-readable artifacts.** A build step generates `docs/static/llms.txt` (link-index), `docs/static/llms-full.txt` (full content), and serves `<path>.md` at every page URL. All three from canonical markdown — front-matter stripped, MDX components inlined.
- **PR template.** [.github/pull_request_template.md](../../../.github/pull_request_template.md) carries the page-acceptance checklist verbatim for any PR touching [docs/](../../../docs/).
- **No docs without this skill's review.** Any change that introduces a new page kind, renames a top-level section, or amends a template requires an explicit update to this skill in the same PR.
