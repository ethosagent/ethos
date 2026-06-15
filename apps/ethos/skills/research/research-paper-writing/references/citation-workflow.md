# Citation Verification Workflow

Every citation in a research paper must pass through this 5-step process. No exceptions. A single hallucinated reference undermines the credibility of the entire paper.

## Step 1: SEARCH

Find the paper using at least one of these sources:

- **arXiv** — use the bundled `search_arxiv.py` script or the arXiv Atom API directly.
- **Semantic Scholar** — `https://api.semanticscholar.org/graph/v1/paper/search?query=<terms>&limit=5`
- **Google Scholar** — via web_search if available.
- **DOI resolution** — if you have a DOI, go directly to `https://doi.org/<DOI>`.

Record the paper's canonical identifier: arXiv ID, DOI, or Semantic Scholar corpus ID.

### What counts as "found"

The paper exists in a public database with matching title, authors, and year. A vague memory of "I think Vaswani et al. wrote something about attention" does not count. You need the actual record.

## Step 2: VERIFY

Confirm the paper exists in at least 2 independent sources. This catches:

- Papers you misremember (wrong title, wrong authors, wrong year).
- Papers that were retracted or withdrawn.
- Papers that don't actually exist (hallucinated references).

**Verification pairs that work:**

| Source 1 | Source 2 |
|----------|----------|
| arXiv | Semantic Scholar |
| DOI resolution | Semantic Scholar |
| Google Scholar | arXiv |
| Publisher page | Semantic Scholar |

**Verification pairs that don't count:**

| Source 1 | Source 2 | Why |
|----------|----------|-----|
| Your memory | Your memory | Not independent |
| arXiv | arXiv mirror | Same database |
| Google Scholar | Google Scholar cache | Same database |

## Step 3: RETRIEVE

Get the real BibTeX entry via DOI content-negotiation:

```bash
curl -LH "Accept: application/x-bibtex" "https://doi.org/<DOI>"
```

For arXiv papers without a journal DOI, use the arXiv DOI:

```bash
curl -LH "Accept: application/x-bibtex" "https://doi.org/10.48550/arXiv.<id>"
```

**Do not hand-write BibTeX entries.** Machine-generated entries from DOI resolution have correct formatting, proper escaping, and accurate metadata. Hand-written entries drift.

If DOI resolution fails (rare but possible), fall back to:

1. The publisher's "Cite this paper" export.
2. Semantic Scholar's BibTeX export: `https://api.semanticscholar.org/graph/v1/paper/<id>?fields=citationStyles` (returns `citationStyles.bibtex`).
3. As a last resort, construct manually from verified metadata — but flag it with a comment `% BibTeX constructed manually — verify`.

## Step 4: VALIDATE

Re-read the cited paper (at least the abstract and relevant sections) and confirm it actually supports the claim you're making.

**Common validation failures:**

- **Claim mismatch.** You cite "Smith et al. showed X" but Smith et al. actually showed Y. This is the most common citation error in academic writing.
- **Context loss.** The paper showed X under specific conditions, but you cite it as a general result.
- **Cherry-picking.** The paper's main finding contradicts your claim, but you cite a minor result that supports it.
- **Version confusion.** You read v1 of the arXiv paper; v3 (the published version) has different results.

### The validation question

Ask yourself: "If the authors of this paper read my sentence, would they agree that I represented their work accurately?"

If the answer is "maybe not" — revise the claim or find a different citation.

## Step 5: MARK

If any of the previous steps fail, insert `[CITATION NEEDED]` at the point where the citation should go. Do not:

- Invent a plausible-sounding reference.
- Cite a different paper that is "close enough."
- Remove the claim entirely (unless it's unsupported and non-essential).
- Leave the claim uncited and hope no one notices.

`[CITATION NEEDED]` is an honest signal that says "this claim needs evidence and I haven't found it yet." It's infinitely better than a fake reference.

## Common failure modes

### The paper doesn't exist

You remember reading about "Johnson et al. (2023), Adaptive Routing in Neural Networks" but no database has it. Likely causes:

- You're conflating two different papers.
- The paper was a preprint that was never formally posted.
- The paper doesn't exist and your memory fabricated it.

**Action:** `[CITATION NEEDED]`. Search for the concept, not the paper — you may find the real source.

### Wrong DOI

The DOI resolves but to a different paper than expected. This happens when:

- You transcribed the DOI incorrectly.
- The DOI was reassigned (rare but real).

**Action:** Cross-check the DOI resolution against the paper title. If they don't match, search for the correct DOI.

### The paper doesn't support the claim

You cite "Lee et al. showed that method X outperforms Y" but Lee et al. actually showed X and Y are comparable under most conditions, with X only winning in a narrow regime.

**Action:** Revise the claim to accurately reflect the cited paper, or find a different citation that supports the original claim.

### Retracted or withdrawn papers

The paper existed but has been retracted or withdrawn.

**Action:** Do not cite retracted papers as supporting evidence. If the retraction is relevant to your discussion (e.g., you're writing about reproducibility), cite it with an explicit note about the retraction.
