#!/usr/bin/env python3
"""Search arXiv papers via the Atom API.

Stdlib-only — no pip dependencies required. Uses urllib.request for HTTP
and xml.etree.ElementTree for Atom XML parsing.

Usage:
    python3 search_arxiv.py "ti:transformer AND cat:cs.CL" --max-results 5
    python3 search_arxiv.py "au:vaswani" --sort-by relevance --max-results 20
"""

import argparse
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ARXIV_API = "http://export.arxiv.org/api/query"

# Atom / arXiv namespaces used in the response XML
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

VALID_SORT_BY = ("relevance", "lastUpdatedDate", "submittedDate")


def build_url(query: str, max_results: int, sort_by: str) -> str:
    """Build the arXiv API query URL."""
    params = urllib.parse.urlencode(
        {
            "search_query": query,
            "sortBy": sort_by,
            "sortOrder": "descending",
            "start": 0,
            "max_results": max_results,
        }
    )
    return f"{ARXIV_API}?{params}"


def fetch_xml(url: str) -> str:
    """Fetch the Atom XML from arXiv. Raises on HTTP errors."""
    req = urllib.request.Request(url, headers={"User-Agent": "ethos-arxiv-search/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        print(f"HTTP error {exc.code}: {exc.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f"Connection error: {exc.reason}", file=sys.stderr)
        sys.exit(1)


def text(element: ET.Element | None) -> str:
    """Extract text from an XML element, or return empty string."""
    if element is None:
        return ""
    return (element.text or "").strip()


def parse_entries(xml_text: str) -> list[dict]:
    """Parse Atom XML and return a list of paper dicts."""
    root = ET.fromstring(xml_text)

    total = text(root.find("opensearch:totalResults", NS))
    if total == "0":
        return []

    entries = root.findall("atom:entry", NS)
    results = []

    for entry in entries:
        title = " ".join(text(entry.find("atom:title", NS)).split())

        authors = [
            text(author.find("atom:name", NS))
            for author in entry.findall("atom:author", NS)
        ]

        # Extract arXiv ID from the entry id URL
        # e.g. http://arxiv.org/abs/2301.12345v1 -> 2301.12345v1
        entry_id = text(entry.find("atom:id", NS))
        arxiv_id = entry_id.rsplit("/", 1)[-1] if entry_id else ""

        # Strip version suffix for display
        arxiv_id_clean = arxiv_id.split("v")[0] if "v" in arxiv_id else arxiv_id

        categories = [
            cat.get("term", "")
            for cat in entry.findall("atom:category", NS)
            if cat.get("term")
        ]

        published = text(entry.find("atom:published", NS))[:10]  # YYYY-MM-DD

        abstract = " ".join(text(entry.find("atom:summary", NS)).split())

        # Find the PDF link
        pdf_link = ""
        for link in entry.findall("atom:link", NS):
            if link.get("title") == "pdf":
                pdf_link = link.get("href", "")
                break

        results.append(
            {
                "title": title,
                "authors": ", ".join(authors),
                "arxiv_id": arxiv_id_clean,
                "categories": ", ".join(categories),
                "published": published,
                "abstract": abstract[:200] + ("..." if len(abstract) > 200 else ""),
                "pdf": pdf_link,
            }
        )

    return results


def print_results(results: list[dict], total: int) -> None:
    """Print results in a readable block format."""
    if not results:
        print("No results found.")
        return

    count = len(results)
    for i, paper in enumerate(results, 1):
        print(f"=== [{i}/{count}] ===")
        print(f"Title:      {paper['title']}")
        print(f"Authors:    {paper['authors']}")
        print(f"arXiv ID:   {paper['arxiv_id']}")
        print(f"Categories: {paper['categories']}")
        print(f"Published:  {paper['published']}")
        print(
            f"Abstract:   {textwrap.fill(paper['abstract'], width=80, subsequent_indent='            ')}"
        )
        print(f"PDF:        {paper['pdf']}")
        print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Search arXiv papers via the Atom API.",
        epilog="Example: python3 search_arxiv.py \"ti:transformer AND cat:cs.CL\" --max-results 5",
    )
    parser.add_argument(
        "query",
        help="arXiv search query (e.g. 'ti:transformer AND cat:cs.CL')",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=10,
        help="Number of results to return (default: 10, max: 100)",
    )
    parser.add_argument(
        "--sort-by",
        choices=VALID_SORT_BY,
        default="lastUpdatedDate",
        help="Sort order (default: lastUpdatedDate)",
    )
    args = parser.parse_args()

    max_results = min(max(1, args.max_results), 100)

    url = build_url(args.query, max_results, args.sort_by)
    xml_text = fetch_xml(url)
    results = parse_entries(xml_text)
    print_results(results, len(results))


if __name__ == "__main__":
    main()
