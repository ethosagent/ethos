---
name: research-paper-writing
description: Draft well-structured, properly cited research papers and reports. Citation discipline (never hallucinate references), standard paper structure, writing principles, and a self-review checklist.
version: 1.0.0
author: ethosagent
tags: [research, writing, papers, citations]
required_tools: [terminal, read_file]

ethos:
  category: research
  default_personalities: [researcher]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [write_file, web_search, web_extract]
  integrates_with:
    - skill: arxiv
      role: paper discovery and BibTeX retrieval for citation verification
    - skill: plan
      role: plan the paper structure before writing
  surface_metadata:
    invocation_trigger: "user says 'write a paper about X', 'draft a research report', 'help me write the methods section', 'review my paper draft'"
    estimated_turns: "5-15"
---

# Research Paper Writing

Draft well-structured, properly cited research papers and reports. This skill enforces citation discipline, provides standard paper structure, and includes a self-review checklist.

## When to use this skill

- Drafting a research paper, technical report, or literature review.
- Writing or revising individual sections (abstract, introduction, methods, etc.).
- Reviewing a draft for structural completeness and citation integrity.
- Building a bibliography from verified sources.

## When NOT to use this skill

- Blog posts, documentation, or marketing copy — those have different structure and tone.
- Slide decks or presentations — different medium, different rules.
- Casual summaries of papers — just read and summarize directly.

## The cardinal rule

**NEVER generate a citation from memory.** Every reference must be verified against a real source before inclusion. If you cannot verify a reference exists and says what you claim it says, insert `[CITATION NEEDED]` instead.

This is non-negotiable. A hallucinated citation is worse than no citation — it poisons the reader's trust in the entire paper. One fake reference calls every other reference into question.

The full citation verification process is in [references/citation-workflow.md](references/citation-workflow.md).

## Paper structure

A standard research paper follows this skeleton. Not every paper needs every section, but deviations should be deliberate.

### Abstract

A self-contained summary of the entire paper in 150-300 words. Use the 5-sentence formula:

1. **Context** — what is the broad area and why does it matter?
2. **Gap** — what specific problem or limitation exists?
3. **Approach** — what did we do to address it?
4. **Result** — what did we find? (include key numbers)
5. **Implication** — why does this matter going forward?

The abstract must match the conclusions. If they diverge, one of them is wrong.

### Introduction

Sets up the problem and motivates the work. Should end with a clear statement of contributions: "In this paper, we..." or equivalent. The reader should know by the end of the introduction exactly what the paper claims and roughly how it gets there.

### Related Work

Survey of prior art that contextualizes this work. Compare, don't just list. For each cited work, explain how it relates to the current paper — what it does well, where it falls short, and how the current work differs. Be fair to prior art; a strawman related work section undermines credibility.

### Method

Describe the approach in enough detail to reproduce it. Another researcher with the same data and compute should be able to replicate the results from this section alone. Include: architecture, training procedure, hyperparameters, data preprocessing, evaluation metrics.

### Experiments / Results

Lead with the main finding, not the experimental setup. Present results with tables and figures. Every number should have context (baseline comparisons, confidence intervals, ablations). Claims drive experiments — every claim in the paper must have corresponding experimental evidence.

### Discussion

Interpret the results. What do they mean? What are the limitations? What surprised you? What would you do differently? State limitations honestly — reviewers will find them anyway; stating them first shows intellectual honesty.

### Conclusion

Summarize contributions and findings. Suggest future work directions. Do not introduce new results here.

### References

Every entry must be verified via the citation workflow. Use consistent formatting (preferably BibTeX-generated). Include DOIs where available.

## Writing principles

See [references/writing-guide.md](references/writing-guide.md) for the expanded version. The essentials:

### The paper tells a story

Problem --> why it matters --> what we did --> what we found --> what it means. Every section advances this narrative. If a paragraph doesn't serve the story, cut it.

### Clarity over cleverness

Use the simplest language that accurately conveys the idea. Gopen & Swan's reader-expectation theory: put familiar information at the start of a sentence (topic position) and new/important information at the end (stress position). The reader's eye naturally lands on the end of the sentence — put the emphasis there.

### Every claim needs evidence

No unsupported assertions. "It is well known that..." is not evidence. "Prior work has shown..." requires a citation. "Our method outperforms..." requires a number and a baseline.

### Paragraphs have structure

Topic sentence (the claim) --> evidence (the data) --> interpretation (what it means) --> transition (how it connects to the next point). One idea per paragraph.

## Citation workflow

The 5-step process for every citation:

1. **SEARCH** — find the paper
2. **VERIFY** — confirm existence in 2+ sources
3. **RETRIEVE** — get real BibTeX via DOI
4. **VALIDATE** — confirm the paper supports your claim
5. **MARK** — if any step fails, insert `[CITATION NEEDED]`

Full details in [references/citation-workflow.md](references/citation-workflow.md).

## Self-review checklist

Run this checklist on every draft before declaring it complete. One pass, top to bottom.

### Structure

- [ ] Does the abstract follow the 5-sentence formula?
- [ ] Does the abstract match the conclusions?
- [ ] Does the introduction end with a clear contributions statement?
- [ ] Does every section advance the paper's narrative?
- [ ] Is the related work a comparison, not a list?

### Evidence

- [ ] Does every claim have supporting evidence (data, citation, or derivation)?
- [ ] Are all experimental results presented with baselines and context?
- [ ] Are confidence intervals or error bars included where appropriate?
- [ ] Do the experiments actually test the claims made in the paper?

### Citations

- [ ] Has every citation been verified via the 5-step workflow?
- [ ] Are there any remaining `[CITATION NEEDED]` markers?
- [ ] Does each cited paper actually support the claim it's attached to?
- [ ] Is the related work fair to prior art?

### Honesty

- [ ] Are limitations stated explicitly?
- [ ] Are there unstated assumptions a skeptical reviewer would catch?
- [ ] Are negative results reported, not hidden?
- [ ] Is the scope of claims proportional to the evidence?

### Writing quality

- [ ] Are there weasel words ("it is well known", "obviously", "clearly")?
- [ ] Are sentences under 25 words on average?
- [ ] Does each paragraph have a clear topic sentence?
- [ ] Is the notation consistent throughout?

## Workflow with other skills

### With the arxiv skill

Use `arxiv` to find papers, explore citation graphs, and retrieve BibTeX. Typical flow:

1. Search for papers on the topic with the arxiv skill.
2. For promising papers, pull citation details from Semantic Scholar.
3. Retrieve BibTeX via DOI content-negotiation.
4. Validate that each cited paper supports the claim you're making.
5. Build the bibliography as you write, not after.

### With the plan skill

For longer papers, use `plan` to outline the structure before writing:

1. Define the research question and contributions.
2. Outline each section with bullet points.
3. Identify which claims need which evidence.
4. Map out the citation needs per section.
5. Then write section by section.

## Anti-patterns

- **Citation from memory.** Never. Use the workflow.
- **Writing the abstract first.** Write it last — it summarizes what you actually wrote, not what you planned to write.
- **Related work as bibliography dump.** Compare and contrast; don't just list.
- **Hiding limitations.** State them before the reviewer finds them.
- **Overfitting the narrative.** If the data doesn't support the story, change the story.
- **Citation padding.** Don't cite papers you haven't read just to lengthen the bibliography.

# Adapted from NousResearch/hermes-agent (MIT)
