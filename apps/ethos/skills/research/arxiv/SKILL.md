---
name: arxiv
description: Search arXiv papers via the Atom API, explore citation graphs via Semantic Scholar, retrieve BibTeX via DOI content-negotiation. Keyless — uses curl + a bundled stdlib-only Python script.
version: 1.0.0
author: ethosagent
tags: [research, arxiv, papers, citations]
required_tools: [terminal]

ethos:
  category: research
  default_personalities: [researcher]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [web_search, web_extract]
  integrates_with:
    - skill: research-paper-writing
      role: provides paper discovery and citation data for the writing workflow
  surface_metadata:
    invocation_trigger: "user says 'find papers about X', 'search arxiv for Y', 'get citations for this paper', 'look up recent work on Z'"
    estimated_turns: "2-5"
---

# arXiv Paper Search & Citation Graph

Search arXiv for academic papers, explore citation graphs via Semantic Scholar, and retrieve BibTeX entries. Everything is keyless — no API keys, no accounts, no setup.

## When to use this skill

- Finding academic papers on a topic (search by title, author, category, or abstract keywords).
- Exploring what a paper cites and what cites it (citation graph traversal).
- Retrieving properly formatted BibTeX for a known paper.
- Surveying recent work in a research area before writing a paper or proposal.

## When NOT to use this skill

- General web research — use web_search instead.
- Finding blog posts, tutorials, or non-academic content.
- Full-text reading of papers — this skill discovers and summarizes metadata; reading the PDF is a separate step.

## arXiv Atom API

The arXiv API uses Atom XML. No authentication required.

**Endpoint:** `http://export.arxiv.org/api/query`

**Query syntax:**

| Prefix | Searches | Example |
|--------|----------|---------|
| `ti:` | Title | `ti:attention+mechanism` |
| `au:` | Author | `au:vaswani` |
| `abs:` | Abstract | `abs:transformer+architecture` |
| `cat:` | Category | `cat:cs.CL` |

Combine with boolean operators: `AND`, `OR`, `ANDNOT`.

```
# Papers about transformers in NLP
ti:transformer AND cat:cs.CL

# Papers by Vaswani about attention
au:vaswani AND ti:attention

# Recent diffusion model papers, excluding images
ti:diffusion AND cat:cs.LG ANDNOT abs:image
```

**Sorting and pagination:**

| Parameter | Values | Default |
|-----------|--------|---------|
| `sortBy` | `relevance`, `lastUpdatedDate`, `submittedDate` | `relevance` |
| `sortOrder` | `ascending`, `descending` | `descending` |
| `start` | integer offset | `0` |
| `max_results` | integer (max 100) | `10` |

**Rate limiting:** Wait at least 3 seconds between requests. The API will return HTTP 503 if you exceed this.

**Raw curl example:**

```bash
curl -s "http://export.arxiv.org/api/query?search_query=ti:transformer+AND+cat:cs.CL&sortBy=lastUpdatedDate&sortOrder=descending&max_results=5"
```

## Using the bundled script

The bundled Python script parses the Atom XML and prints structured results:

```bash
python3 scripts/search_arxiv.py "ti:transformer AND cat:cs.CL" --max-results 5
```

Options:
- First positional argument: the search query (arXiv query syntax).
- `--max-results N`: number of results (default 10, max 100).
- `--sort-by`: one of `relevance`, `lastUpdatedDate`, `submittedDate` (default `lastUpdatedDate`).

Output is one block per paper:

```
=== [1/5] ===
Title:    Attention Is All You Need
Authors:  Ashish Vaswani, Noam Shazeer, Niki Parmar, ...
arXiv ID: 1706.03762
Categories: cs.CL, cs.LG
Published: 2017-06-12
Abstract:  The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...
PDF:      https://arxiv.org/pdf/1706.03762
```

The script is stdlib-only Python 3 (no pip install needed).

## Semantic Scholar API

Keyless access. No authentication required for low-volume use.

### Paper details

```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762?fields=title,authors,year,citationCount,references,citations"
```

Returns title, author list, year, citation count, and lists of references and citations.

### Citations (papers that cite this one)

```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762/citations?fields=title,year,citationCount&limit=100"
```

### References (papers this one cites)

```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762/references?fields=title,year,citationCount"
```

### Paper recommendations

```bash
curl -s "https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:1706.03762?fields=title,year,citationCount&limit=10"
```

Returns papers similar to the given one. Useful for expanding a literature survey.

### Parsing Semantic Scholar responses

All responses are JSON. Use `jq` for quick extraction:

```bash
# Get the top 10 most-cited papers that cite "Attention Is All You Need"
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762/citations?fields=title,year,citationCount&limit=100" \
  | jq '[.data[].citingPaper | select(.citationCount != null)] | sort_by(-.citationCount) | .[0:10] | .[] | {title, year, citationCount}'
```

## BibTeX retrieval

Use DOI content-negotiation to get properly formatted BibTeX:

```bash
curl -LH "Accept: application/x-bibtex" "https://doi.org/10.48550/arXiv.1706.03762"
```

This works for any paper with a DOI. arXiv papers have DOIs of the form `10.48550/arXiv.<id>`.

If you only have the arXiv ID, construct the DOI: `10.48550/arXiv.<id>` (e.g., `10.48550/arXiv.2301.12345`).

## arXiv ID format

Two formats exist:

| Style | Pattern | Example | Era |
|-------|---------|---------|-----|
| Old | `<archive>/<YYMMNNN>` | `math/0601001` | Before 2007-04 |
| New | `YYMM.NNNNN` | `2301.12345` | 2007-04 onward |

Papers have versions: `2301.12345v1`, `2301.12345v2`, etc. The versionless ID (`2301.12345`) always resolves to the latest version.

**For Semantic Scholar lookups, always use the versionless ID** — `arXiv:2301.12345`, not `arXiv:2301.12345v2`.

## Gotchas

- **Rate limiting:** arXiv enforces a 3-second wait between API calls. The bundled script handles this for single queries, but if you make multiple calls in sequence, add `sleep 3` between them.
- **Withdrawn papers:** Withdrawn papers still appear in search results. Check the abstract for withdrawal notices. The presence of `<arxiv:journal_ref>` suggests the paper was published in a journal (good sign).
- **Semantic Scholar lag:** Newly posted arXiv papers may not appear in Semantic Scholar for 2-3 days. If a paper is very recent, rely on arXiv metadata alone.
- **Search encoding:** In URLs, spaces in query terms should be encoded as `+` (e.g., `ti:attention+mechanism`). The bundled script handles this automatically.
- **Max results cap:** arXiv API caps at 100 results per request. For larger surveys, paginate using `start` and `max_results`.
- **Category codes:** Common CS categories: `cs.AI` (artificial intelligence), `cs.CL` (computation and language / NLP), `cs.CV` (computer vision), `cs.LG` (machine learning), `cs.CR` (cryptography), `cs.SE` (software engineering). Full list at `https://arxiv.org/category_taxonomy`.

# Adapted from NousResearch/hermes-agent (MIT)
