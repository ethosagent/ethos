# Research Paper Writing Guide

Expanded writing principles for academic papers and technical reports.

## The 5-sentence abstract formula

Every abstract should answer these five questions, roughly one sentence each:

1. **Context:** What is the broad area, and why should anyone care?
2. **Gap:** What specific problem, limitation, or open question exists?
3. **Approach:** What did we do to address it?
4. **Result:** What did we find? (Include the key quantitative result.)
5. **Implication:** Why does this matter going forward?

### Template

> [AREA] is important because [WHY]. However, current approaches [LIMITATION]. In this paper, we [APPROACH]. Our experiments on [BENCHMARK] show [KEY RESULT, with numbers]. These results suggest [IMPLICATION], opening the door to [FUTURE DIRECTION].

### Example

> Large language models have become the dominant approach for natural language understanding tasks. However, their deployment costs scale linearly with sequence length, limiting applicability to long-document settings. In this paper, we propose Sparse Attention Routing, which dynamically selects a subset of attention heads per input token. On the LongBench benchmark, our method reduces inference cost by 43% while maintaining 98.2% of the baseline accuracy. These results demonstrate that adaptive computation allocation can substantially improve the cost-accuracy tradeoff for long-context language models.

## Gopen & Swan: reader-expectation theory

George Gopen and Judith Swan's framework ("The Science of Scientific Writing", American Scientist, 1990) identifies two key positions in every sentence:

### Topic position (first ~7 words)

The opening of a sentence sets the reader's expectations. Put familiar information here — something the reader already knows or that connects to the previous sentence. This creates continuity.

**Weak:** "A 43% reduction in inference cost was achieved by our method."
**Strong:** "Our method reduces inference cost by 43%."

In the weak version, the reader processes "a 43% reduction" before knowing what produced it. In the strong version, "our method" connects to the previous context immediately.

### Stress position (end of the sentence)

The end of a sentence carries natural emphasis — it's where the reader's attention peaks. Put the new, important information here.

**Weak:** "Our method, which reduces inference cost by 43% while maintaining accuracy, is called Sparse Attention Routing."
**Strong:** "Our method, Sparse Attention Routing, reduces inference cost by 43% while maintaining accuracy."

In the weak version, the emphasis falls on the name (which is just a label). In the strong version, the emphasis falls on the result (which is the point).

### The rule

Old information at the beginning, new information at the end. Every sentence.

## Paragraph structure

Each paragraph is a self-contained unit of argument:

1. **Topic sentence** — the claim or point this paragraph makes. A reader skimming only topic sentences should get the gist of the paper.
2. **Evidence** — data, citations, examples, or derivations that support the claim.
3. **Interpretation** — what the evidence means in context. Don't leave the reader to draw conclusions.
4. **Transition** — connect to the next paragraph. This can be explicit ("In contrast, ...") or implicit (the next topic sentence picks up where this paragraph left off).

One idea per paragraph. If you find yourself making two points, split into two paragraphs.

## Section-specific advice

### Introduction

- Start broad, narrow to the specific problem.
- The last paragraph should state contributions explicitly: "In this paper, we (1) ..., (2) ..., (3) ..."
- Do not bury the contributions. The reader should know what you did by the end of page 1.
- Avoid "the rest of this paper is organized as follows" boilerplate unless the paper structure is genuinely unusual.

### Related work

- Group by theme, not chronologically.
- For each group, explain the shared approach, then differentiate individual papers.
- End each group with how the current work relates: "Unlike [prior work], we ..." or "Building on [prior work], we extend ..."
- Be fair. Do not misrepresent prior work to make yours look better. Reviewers know the field.

### Methods

- Write for reproduction. Another researcher should be able to implement your method from this section alone.
- Include hyperparameters, training details, data preprocessing steps.
- Use pseudocode or algorithm blocks for complex procedures.
- Define notation on first use and keep it consistent throughout.

### Results

- Lead with the main finding in the first sentence of the section.
- Every table and figure needs a caption that stands alone — the reader should understand it without reading the body text.
- Report baselines alongside your results. Improvements without context are meaningless.
- Include ablation studies: remove components one at a time to show each one's contribution.

### Discussion

- Interpret, don't repeat. The results section has the numbers; the discussion explains what they mean.
- Address limitations proactively. State what your method cannot do.
- Compare with expectations — did the results surprise you? Why or why not?

## Common anti-patterns

### Weasel words

Words that sound authoritative but say nothing:

- "It is well known that..." — then cite the source.
- "Obviously..." — if it's obvious, you don't need to say so.
- "Clearly..." — same problem.
- "It has been shown that..." — by whom? cite it.
- "Significant improvement" — how much? what's the p-value?

### Unnecessary hedging

Some hedging is honest ("our results suggest" when you have suggestive but not conclusive evidence). Excess hedging is noise:

- "We believe that our method might potentially be able to somewhat improve..." --> "Our method improves..."
- "It could be argued that perhaps..." --> state the argument directly.

### Overly long sentences

If a sentence exceeds 30 words, consider splitting it. Academic writing is not literary fiction — clarity beats elegance. Read your sentences aloud; if you run out of breath, the sentence is too long.

### Citation padding

Don't cite papers you haven't read. Don't add citations to inflate the bibliography. Each citation should serve a specific purpose: supporting a claim, providing context, or crediting prior work.

### Passive voice overuse

Some passive voice is natural in methods sections ("the data were collected", "the model was trained"). But the default should be active voice:

- **Passive:** "An improvement of 12% was observed when the model was fine-tuned."
- **Active:** "Fine-tuning the model improved performance by 12%."

Active voice is shorter, clearer, and more direct.
