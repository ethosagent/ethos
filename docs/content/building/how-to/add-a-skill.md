---
title: "Add a skill"
description: "Author a SKILL.md file with agentskills frontmatter, drop it in a scanned source, and tune the per-personality filter so the right roles see it."
kind: how-to
audience: developer
slug: add-a-skill
time: "10 min"
updated: 2026-05-12
---

## Task

Author a markdown-defined [skill](../../getting-started/glossary.md#skill), place it where the universal scanner finds it, and configure the per-personality filter so only the right [personalities](../../getting-started/glossary.md#personality) load it.

## Result

The skill is parsed at boot, deduped by qualified name (`<source>/<name>`), and added to the skill pool. Personalities whose toolset reaches the skill's `required_tools` see it; the rest do not. `ethos doctor --skills` lists it under the source label and visibility per personality.

## Prereqs

- An installed Ethos (`ethos --version` returns a string).
- A clear answer to "what should the agent do when this skill activates?" — one paragraph or a numbered procedure.
- The list of [tools](../../getting-started/glossary.md#tool) the skill needs. The filter blocks any skill whose `required_tools` are outside the personality's toolset.

## Steps

### 1. Pick the source directory

Ethos scans these paths at startup. Pick the one that matches the skill's scope.

| Path | Source label | Visible to |
|---|---|---|
| `~/.ethos/skills/<name>/SKILL.md` | `ethos` | All projects on this machine. |
| `<repo>/.ethos/skills/<name>/SKILL.md` | `ethos-project` | Anyone running Ethos inside this checkout. Commit to share. |
| `~/.claude/skills/<name>/SKILL.md` | `claude-code` | Ethos AND Claude Code. Best for cross-framework skills. |
| `~/.ethos/personalities/<id>/skills/<name>/SKILL.md` | per-personality | Only the named personality. Always loads, bypasses the filter. |

`skills/data/<category>/<name>/SKILL.md` is the bundled location; it ships inside the framework and is read-only at runtime. Add new skills under one of the user paths.

### 2. Write the SKILL.md file

Every skill is one directory with `SKILL.md` as the entrypoint. Supporting files (scripts, references) live alongside it and are loaded only when the skill body references them.

```markdown title="~/.ethos/skills/explain-code/SKILL.md"
---
name: explain-code
description: Explain unfamiliar code with an analogy and a small ASCII diagram. Use when the user asks "how does this work?" or wants a tour of a file they didn't write.
tags: [coding, explanation]
required_tools: [read_file]
---

# Explain code

When the user asks how a piece of code works:

1. Read the file with `read_file`.
2. Open with a one-sentence analogy from everyday life.
3. Draw an ASCII diagram showing the data flow (3–6 lines).
4. Walk through the code in execution order, skipping import boilerplate.
5. Close with one gotcha — something the reader will trip over if they edit it.
```

Frontmatter fields the scanner reads:

| Field | Required | Purpose |
|---|---|---|
| `name` | No | Slug for `/skill-name` invocation. Defaults to the directory name. |
| `description` | Yes (in practice) | The agent reads this to decide when to load the skill. Keep keywords up front. |
| `required_tools` | No | The filter compares this list against the personality's toolset. Skills with no declaration are allowed by default (`fallback_unknown: allow`). |
| `tags` | No | Used by `tags` filter mode and the deny list. |
| `disable-model-invocation` | No | `true` blocks LLM-initiated activation. Use for skills with destructive side effects. |

Other frontmatter fields from the agentskills.io spec are accepted by the parser and ignored when Ethos has no use for them yet, so your skills stay portable.

### 3. Configure the per-personality filter

The personality picks how it ingests the global skill pool. The default is `capability` — a skill is visible only if every entry in its `required_tools` is in the personality's `toolset.yaml`. Override in the personality's `config.yaml`:

```yaml title="~/.ethos/personalities/researcher/config.yaml"
name: Researcher
description: Methodical research agent
model: claude-opus-4-7
memoryScope: global

skills:
  global_ingest:
    mode: capability   # default — required_tools must subset personality.toolset
```

Four modes are available.

| Mode | Behaviour | When to use |
|---|---|---|
| `capability` (default) | Auto-allow if `required_tools ⊆ personality.toolset`. | The personality's toolset is the natural gate. Best for most roles. |
| `tags` | Match if any skill tag is in the personality's `accept_tags`; reject if any tag is in `reject_tags`. Capability check still runs after. | Skills are tagged semantically and you want grouping by tag. |
| `explicit` | Default-deny — only skills in `allow` are loaded. Capability check still runs after. | Narrow-purpose personalities with hand-curated libraries. |
| `none` | Disable global ingest entirely. | Personalities that should only use skills in their own `~/.ethos/personalities/<id>/skills/` folder. |

Example `tags` and `explicit` configs (skill names use the qualified `<source>/<name>` format from the boot output):

```yaml
skills:
  global_ingest:
    mode: tags
    accept_tags: [research, citation]
    reject_tags: [deploy, irreversible]
```

```yaml
skills:
  global_ingest:
    mode: explicit
    allow: [claude-code/code-review, ethos/explain-code]
    deny:  [claude-code/auto-commit]    # checked first; wins over every mode
```

`deny` is checked first — anything listed is rejected even if the mode would have allowed it.

### 4. Skip the filter for one personality

To bypass every filter rule for one personality, drop the skill inside its directory:

```text
~/.ethos/personalities/researcher/
├── SOUL.md
├── config.yaml
├── toolset.yaml
└── skills/
    └── citation-style/SKILL.md   ← always loads for researcher
```

This is the explicit hand-curated library — bypassing the global filter is intentional.

## Verify

Boot the agent and check the skill registry:

```bash
ethos doctor --skills
```

Expect output like:

```text
Skills loaded: 47 total · 14 visible to researcher
  sources: ethos (12), claude-code (28), openclaw (7)
  visible to researcher: ethos/explain-code, claude-code/citation-format, ...
```

Then invoke the skill directly:

```bash
ethos chat -q "/explain-code src/auth/login.ts"
```

A turn that opens with the analogy you wrote in `SKILL.md` confirms the skill loaded and the LLM followed it.

## Troubleshoot

**Skill not in the boot output at all.** — The scanner did not find the directory. Confirm the path matches one of the discovered sources. `~/.claude/skills/explain-code/SKILL.md` is right; `~/.claude/skills/explain-code.md` is wrong — every skill is its own directory.

**Skill is in the pool but not visible to the personality.** — The filter is rejecting it. Check `capability` mode: every entry in `required_tools` must appear in the personality's `toolset.yaml`. A skill with `required_tools: [terminal, web_extract]` will not reach a personality whose toolset is `[web_search, read_file]`.

**No `required_tools` declared, skill still rejected.** — The personality has `fallback_unknown: deny` set. Either declare `required_tools`, add the skill to the `allow` list under `explicit` mode, or drop it into the personality's own `skills/` folder.

**Skill loads but never activates.** — The `description` is missing or buried. The LLM reads the description (not the body) to decide when to load. Move the activation keywords to the first sentence: who needs this, when, and what it does.

**Frontmatter not parsing.** — The file is missing the leading `---` delimiter or the YAML is malformed. Run `head -10 ~/.ethos/skills/<name>/SKILL.md`; the first line must be exactly `---`, and the closing `---` must be on its own line.

**Duplicate skill names across sources.** — The scanner dedupes by qualified name (`<source>/<name>`), so two sources with the same skill name coexist. To override an `ethos-bundled` skill, drop a same-named directory under `~/.ethos/skills/`; the user source wins.
