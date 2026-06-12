/**
 * Schema.org JSON-LD injection — adds a `<script type="application/ld+json">`
 * block to every doc page's `<head>` based on its `kind` front-matter. AI
 * answer cards (Google AI Mode, Claude, Perplexity, ChatGPT Search) read
 * structured data to decide which excerpt to surface; without it our pages
 * compete on raw HTML and lose.
 *
 * Mapping per DOCS.md § "Structured data (Schema.org JSON-LD)":
 *
 *   tutorial / how-to  → HowTo
 *   reference / explanation / decision → TechArticle
 *   troubleshooting.md → FAQPage (one Q&A per entry)
 *   glossary.md → DefinedTermSet
 *
 * Implementation: postBuild walks the generated HTML, finds each doc page,
 * resolves the matching source markdown, injects the right JSON-LD block.
 * Done at HTML-rewrite time rather than via MDX because per-page injection
 * needs both front-matter (in markdown) and the final rendered URL (in HTML).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { LoadContext, Plugin } from '@docusaurus/types';

interface PluginOptions {
  contentDir?: string;
  routeBasePath?: string;
  siteUrl?: string;
}

interface PageFrontMatter {
  title?: string;
  description?: string;
  kind?: string;
  audience?: string;
  slug?: string;
  agent?: boolean;
  updated?: string;
}

export default function jsonLdPlugin(
  context: LoadContext,
  options: PluginOptions = {},
): Plugin<void> {
  const contentDir = options.contentDir ?? 'content';
  const routeBasePath = options.routeBasePath ?? 'docs';
  const siteUrl = options.siteUrl ?? context.siteConfig.url ?? '';

  return {
    name: 'ethos-json-ld',

    async postBuild({ outDir, siteDir }) {
      const sourceRoot = join(siteDir, contentDir);
      const sources = walk(sourceRoot);

      let injected = 0;
      let cardsRewired = 0;
      for (const filePath of sources) {
        const rel = relative(sourceRoot, filePath);
        const source = readFileSync(filePath, 'utf8');
        const { frontMatter, body } = parseFrontMatter(source);

        const route = routeFor(rel, frontMatter, routeBasePath);
        const htmlPath = join(outDir, route.replace(/^\//, ''), 'index.html');

        const exists = (() => {
          try {
            return statSync(htmlPath).isFile();
          } catch {
            return false;
          }
        })();
        if (!exists) continue;

        const ld = buildJsonLd(frontMatter, body, `${siteUrl}${route}`, rel);
        let html = readFileSync(htmlPath, 'utf8');
        let mutated = false;

        if (ld) {
          const next = injectIntoHead(html, ld);
          if (next !== html) {
            html = next;
            mutated = true;
            injected++;
          }
        }

        // Per-page Open Graph / Twitter card. The card image was emitted at
        // `prebuild` time by `scripts/generate-cards.ts` — slug shape mirrors
        // that script. Skip rewriting when no per-page card exists (e.g.,
        // pages with `agent: false`); Docusaurus's global `themeConfig.image`
        // remains the fallback for those.
        const cardSlug = cardSlugFor(rel, frontMatter);
        const cardUrl = `${siteUrl}/img/og/${cardSlug}.png`;
        const cardOnDisk = join(outDir, 'img', 'og', `${cardSlug}.png`);
        const cardExists = (() => {
          try {
            return statSync(cardOnDisk).isFile();
          } catch {
            return false;
          }
        })();
        if (cardExists) {
          const rewired = rewireOgImage(html, cardUrl);
          if (rewired !== html) {
            html = rewired;
            mutated = true;
            cardsRewired++;
          }
        }

        if (mutated) writeFileSync(htmlPath, html, 'utf8');
      }
      console.log(
        `[json-ld] injected Schema.org into ${injected} pages, rewired og:image on ${cardsRewired} pages`,
      );
    },
  };
}

/**
 * Mirror of `scripts/generate-cards.ts`'s slug convention — directories
 * joined by `__`, landing page resolves to `default`. Both sides must agree
 * or pages fall back to the global `themeConfig.image`.
 */
function cardSlugFor(rel: string, fm: PageFrontMatter): string {
  if (fm.slug === '/') return 'default';
  return rel.replace(/\.(md|mdx)$/, '').replaceAll(sep, '__');
}

/**
 * Replace the `og:image` and `twitter:image` `content=` attributes in the
 * built HTML's `<head>`. Docusaurus emits unquoted attributes; the regex
 * tolerates both quoting styles.
 */
function rewireOgImage(html: string, cardUrl: string): string {
  let out = html;
  out = out.replace(
    /(<meta\s+[^>]*property=["']?og:image["']?\s+[^>]*content=)(["']?)([^"'\s>]+)\2/g,
    `$1$2${cardUrl}$2`,
  );
  out = out.replace(
    /(<meta\s+[^>]*name=["']?twitter:image["']?\s+[^>]*content=)(["']?)([^"'\s>]+)\2/g,
    `$1$2${cardUrl}$2`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Schema.org builders — keyed on `kind`
// ---------------------------------------------------------------------------

function buildJsonLd(
  fm: PageFrontMatter,
  body: string,
  url: string,
  relPath: string,
): string | null {
  const title = fm.title ?? '';
  const description = fm.description ?? '';

  // troubleshooting.md gets one FAQPage with one Question per entry.
  if (relPath === 'troubleshooting.md' || relPath === 'troubleshooting.mdx') {
    return renderFaqPage(title, url, body);
  }

  // glossary gets DefinedTermSet — one DefinedTerm per `### Term {#anchor}`.
  if (
    relPath.endsWith('getting-started/glossary.md') ||
    relPath.endsWith('getting-started/glossary.mdx')
  ) {
    return renderDefinedTermSet(title, description, url, body);
  }

  switch (fm.kind) {
    case 'tutorial':
    case 'how-to':
      return renderHowTo(title, description, url, fm.updated);
    case 'reference':
    case 'explanation':
    case 'decision':
      return renderTechArticle(title, description, url, fm.updated);
    default:
      // Pages without an explicit kind (intro, changelog) still get a
      // baseline TechArticle so search snippets land cleanly.
      return renderTechArticle(title, description, url, fm.updated);
  }
}

function renderHowTo(
  name: string,
  description: string,
  url: string,
  dateModified?: string,
): string {
  return jsonScript({
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    description,
    url,
    ...(dateModified ? { dateModified } : {}),
  });
}

function renderTechArticle(
  name: string,
  description: string,
  url: string,
  dateModified?: string,
): string {
  return jsonScript({
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: name,
    description,
    url,
    ...(dateModified ? { dateModified } : {}),
  });
}

function renderFaqPage(name: string, url: string, body: string): string {
  // Each H2 in troubleshooting.md is an error entry. The H3-less body that
  // follows (up to the next H2) is the answer. Cause/Fix/Prevent are
  // inlined into the answer text.
  const entries = parseFaqEntries(body);
  return jsonScript({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    name,
    url,
    mainEntity: entries.map((e) => ({
      '@type': 'Question',
      name: e.question,
      acceptedAnswer: { '@type': 'Answer', text: e.answer },
    })),
  });
}

function renderDefinedTermSet(
  name: string,
  description: string,
  url: string,
  body: string,
): string {
  // Glossary uses `### Term {#anchor}` shape.
  const terms = parseGlossaryTerms(body);
  return jsonScript({
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    name,
    description,
    url,
    hasDefinedTerm: terms.map((t) => ({
      '@type': 'DefinedTerm',
      name: t.term,
      description: t.definition,
      url: `${url}#${t.anchor}`,
    })),
  });
}

function jsonScript(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  return `<script type="application/ld+json">${json}</script>`;
}

// ---------------------------------------------------------------------------
// Markdown parsers (intentionally tiny)
// ---------------------------------------------------------------------------

function parseFrontMatter(source: string): { frontMatter: PageFrontMatter; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontMatter: {}, body: source };
  const [, raw, body] = match;
  const frontMatter: PageFrontMatter = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'agent') frontMatter.agent = value !== 'false';
    else if (key === 'title') frontMatter.title = value;
    else if (key === 'description') frontMatter.description = value;
    else if (key === 'kind') frontMatter.kind = value;
    else if (key === 'audience') frontMatter.audience = value;
    else if (key === 'slug') frontMatter.slug = value;
    else if (key === 'updated') frontMatter.updated = value;
  }
  return { frontMatter, body };
}

interface FaqEntry {
  question: string;
  answer: string;
}

function parseFaqEntries(body: string): FaqEntry[] {
  const out: FaqEntry[] = [];
  // Split on H2 boundaries. Stop H3-or-higher under a single entry.
  const segments = body.split(/\n## /);
  // First segment is preamble before first H2; skip.
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const newlineIdx = seg.indexOf('\n');
    if (newlineIdx === -1) continue;
    const heading = seg.slice(0, newlineIdx).trim();
    const rest = seg.slice(newlineIdx + 1).trim();
    // Drop {#anchor} suffix from question text.
    const question = heading.replace(/\s*\{#[^}]+\}\s*$/, '').trim();
    // Trim rest at the next H2 (already handled by split) or H3 if it
    // exists; but for FAQ semantics we keep all sub-content.
    const answer = stripFences(rest);
    if (question && answer) out.push({ question, answer });
  }
  return out;
}

interface GlossaryTerm {
  term: string;
  anchor: string;
  definition: string;
}

function parseGlossaryTerms(body: string): GlossaryTerm[] {
  const out: GlossaryTerm[] = [];
  // The Phase-2 glossary uses `### Term {#anchor}` headings under cluster
  // H2s. Old `<dt>` HTML form is also tolerated as a fallback.
  const heading = /^### (.+?)\s*\{#([a-z0-9-]+)\}\s*$/gm;
  // Assignment lifted out of the while-condition so it isn't an assignment-in-expression.
  let m: RegExpExecArray | null = heading.exec(body);
  while (m !== null) {
    const term = m[1].trim();
    const anchor = m[2];
    // Pull the paragraph immediately after the heading as the definition.
    const start = heading.lastIndex;
    const nextHeading = body.slice(start).search(/\n#{2,3} /);
    const segment = nextHeading === -1 ? body.slice(start) : body.slice(start, start + nextHeading);
    const definition = stripFences(segment).trim().split('\n\n')[0]?.trim() ?? '';
    if (term && definition) out.push({ term, anchor, definition });
    m = heading.exec(body);
  }
  return out;
}

function stripFences(s: string): string {
  // Don't drop fenced code from JSON-LD bodies — search snippets handle them
  // gracefully. Just normalise whitespace.
  return s.replace(/\r/g, '').trim();
}

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------

function injectIntoHead(html: string, script: string): string {
  // Avoid double-injection on incremental builds.
  if (html.includes('"@type":"HowTo"') && script.includes('"@type":"HowTo"')) return html;
  if (html.includes('"@type":"TechArticle"') && script.includes('"@type":"TechArticle"'))
    return html;
  if (html.includes('"@type":"FAQPage"') && script.includes('"@type":"FAQPage"')) return html;
  if (html.includes('"@type":"DefinedTermSet"') && script.includes('"@type":"DefinedTermSet"')) {
    return html;
  }
  return html.replace('</head>', `${script}</head>`);
}

// ---------------------------------------------------------------------------
// Route resolver
// ---------------------------------------------------------------------------

function routeFor(rel: string, fm: PageFrontMatter, routeBasePath: string): string {
  if (fm.slug === '/') return `/${routeBasePath}`;
  // Docusaurus rule: `slug:` replaces only the LAST path segment of the
  // route, not the whole route. So `platforms/slack.md` with
  // `slug: platform-slack` resolves to `/docs/platforms/platform-slack`.
  const segments = rel
    .replace(/\.(md|mdx)$/, '')
    .replaceAll(sep, '/')
    .split('/');
  if (fm.slug && fm.slug !== segments[segments.length - 1]) {
    segments[segments.length - 1] = fm.slug;
  }
  return `/${routeBasePath}/${segments.join('/')}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.md') || full.endsWith('.mdx')) out.push(full);
  }
  return out;
}
