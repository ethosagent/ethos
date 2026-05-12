/**
 * `pnpm docs:check` — page-acceptance gate.
 *
 * Runs the DOCS.md page-acceptance checklist as a script so the rules are
 * mechanically enforced, not only by reviewer eyes. Eight checks; any failure
 * exits non-zero. Warnings (length sanity) print without failing.
 *
 *   1. Front-matter validator  — required fields + audience↔directory + ≤155-char description
 *   2. Marketing-voice detector — banned phrases in description
 *   3. Stable-anchor check      — explicit {#kebab-id} on every H2/H3 in reference/ + glossary
 *   4. Required-sections grep   — per kind: tutorial / how-to / reference / explanation
 *   5. Prohibited-content grep  — anti-pattern phrases + emoji-in-headings
 *   6. JSON-LD parse check      — every page's injected <script> parses as JSON (post-build)
 *   7. Length sanity            — warn (don't fail) under 50 or over kind ceiling
 *   8. Orphan check             — every page reachable from sidebars.ts or another page
 *
 * Run from the repo root via `pnpm docs:check`. The script is path-independent;
 * it walks up from its own location to find docs/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __dirname: string | undefined;
const SCRIPT_DIR =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(SCRIPT_DIR, '..');
const CONTENT_DIR = join(DOCS_ROOT, 'content');
const BUILD_DOCS_DIR = join(DOCS_ROOT, 'build', 'docs');
const SIDEBARS_FILE = join(DOCS_ROOT, 'sidebars.ts');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const KIND_VALUES = ['tutorial', 'how-to', 'reference', 'explanation'] as const;
type Kind = (typeof KIND_VALUES)[number];

const AUDIENCE_VALUES = ['user', 'developer', 'shared'] as const;
type Audience = (typeof AUDIENCE_VALUES)[number];

interface PageFrontMatter {
  title?: string;
  description?: string;
  kind?: string;
  audience?: string;
  slug?: string;
  agent?: boolean;
  time?: string;
  updated?: string;
}

interface Page {
  filePath: string;
  relPath: string;
  routePath: string;
  frontMatter: PageFrontMatter;
  body: string;
}

interface Finding {
  level: 'error' | 'warn';
  file: string;
  message: string;
  line?: number;
}

const findings: Finding[] = [];

function fail(file: string, message: string, line?: number): void {
  findings.push({ level: 'error', file, message, ...(line !== undefined ? { line } : {}) });
}
function warn(file: string, message: string, line?: number): void {
  findings.push({ level: 'warn', file, message, ...(line !== undefined ? { line } : {}) });
}

// ---------------------------------------------------------------------------
// Configuration — single source of truth for what the checks enforce
// ---------------------------------------------------------------------------

const DESCRIPTION_MAX_CHARS = 155;

// DOCS.md §Anti-patterns marketing phrases. CI greps the description field
// for these; they read as marketing in search snippets and AI answer cards.
const MARKETING_PHRASES: ReadonlyArray<string> = [
  'Learn how to',
  'Harness the power',
  'Harness',
  'Unlock',
  'Discover',
  'the best way to',
];

// Prohibited body content — phrases the page must not contain anywhere.
const PROHIBITED_BODY_PHRASES: ReadonlyArray<string> = [
  'Welcome to',
  'click here',
  'Coming soon',
  'WIP',
];

// Required H2s per kind. CI greps for each section title appearing on its
// own line (allows trailing `{#anchor}` for reference / glossary pages).
const REQUIRED_SECTIONS: Record<Kind, ReadonlyArray<string>> = {
  tutorial: ['## Goal', '## Prereqs', '## What you learned', '## Next step'],
  'how-to': ['## Task', '## Result', '## Verify'],
  reference: [], // reference uses a special check below: ## Synopsis OR ## Source.
  explanation: [], // explanation uses a special check: title ends with `?`.
};

// `tutorial` and `how-to` get a length ceiling per DOCS.md §Page types.
const LENGTH_CEILINGS: Record<Kind, number> = {
  tutorial: 700,
  'how-to': 300,
  reference: 500,
  explanation: 400,
};
const LENGTH_MIN_WARN = 50;

// Schema.org @type per kind, used by the JSON-LD parse check.
const SCHEMA_TYPE_BY_KIND: Record<Kind, string> = {
  tutorial: 'HowTo',
  'how-to': 'HowTo',
  reference: 'TechArticle',
  explanation: 'TechArticle',
};

// ---------------------------------------------------------------------------
// Walk content
// ---------------------------------------------------------------------------

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

function parseFrontMatter(source: string): { frontMatter: PageFrontMatter; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontMatter: {}, body: source };
  const [, raw, body] = match;
  const fm: PageFrontMatter = {};
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
    if (key === 'agent') fm.agent = value !== 'false';
    else if (key === 'title') fm.title = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'kind') fm.kind = value;
    else if (key === 'audience') fm.audience = value;
    else if (key === 'slug') fm.slug = value;
    else if (key === 'time') fm.time = value;
    else if (key === 'updated') fm.updated = value;
  }
  return { frontMatter: fm, body };
}

function routeFor(relPath: string, fm: PageFrontMatter): string {
  if (fm.slug === '/') return '/docs';
  const segments = relPath
    .replace(/\.(md|mdx)$/, '')
    .replaceAll(sep, '/')
    .split('/');
  if (fm.slug && fm.slug !== segments[segments.length - 1]) {
    segments[segments.length - 1] = fm.slug;
  }
  return `/docs/${segments.join('/')}`;
}

function loadPages(): Page[] {
  return walk(CONTENT_DIR).map((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    const { frontMatter, body } = parseFrontMatter(source);
    const relPath = relative(CONTENT_DIR, filePath);
    return {
      filePath,
      relPath,
      routePath: routeFor(relPath, frontMatter),
      frontMatter,
      body,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. Front-matter validator
// ---------------------------------------------------------------------------

function checkFrontMatter(page: Page): void {
  const fm = page.frontMatter;
  const f = page.relPath;

  // Required fields.
  if (!fm.title) fail(f, 'Missing required front-matter field: title');
  if (!fm.description) fail(f, 'Missing required front-matter field: description');
  if (!fm.kind) fail(f, 'Missing required front-matter field: kind');
  if (!fm.audience) fail(f, 'Missing required front-matter field: audience');
  if (!fm.updated) fail(f, 'Missing required front-matter field: updated');

  // Enum checks.
  if (fm.kind && !KIND_VALUES.includes(fm.kind as Kind)) {
    fail(f, `Invalid kind "${fm.kind}" — must be one of ${KIND_VALUES.join(' | ')}`);
  }
  if (fm.audience && !AUDIENCE_VALUES.includes(fm.audience as Audience)) {
    fail(f, `Invalid audience "${fm.audience}" — must be one of ${AUDIENCE_VALUES.join(' | ')}`);
  }

  // Description ≤155 chars.
  if (fm.description && fm.description.length > DESCRIPTION_MAX_CHARS) {
    fail(
      f,
      `description is ${fm.description.length} chars (max ${DESCRIPTION_MAX_CHARS}). Trim it — this string is the source of truth for search snippets, OG cards, and AI answer cards.`,
    );
  }

  // Audience must agree with the directory.
  if (fm.audience) {
    const expectedDir = audienceDirectory(fm.audience as Audience);
    if (expectedDir && !page.relPath.split(sep).includes(expectedDir)) {
      // Top-level files (intro.md, troubleshooting.md, changelog.md) live at
      // the root and declare audience: shared. Tolerate those.
      const isTopLevel = !page.relPath.includes(sep);
      if (!(isTopLevel && fm.audience === 'shared')) {
        fail(
          f,
          `audience: ${fm.audience} but directory says otherwise. ${expectedDir}/ pages must declare audience: ${fm.audience}, and vice versa.`,
        );
      }
    }
  }
}

function audienceDirectory(audience: Audience): string | null {
  if (audience === 'user') return 'using';
  if (audience === 'developer') return 'building';
  // `shared` has no single dir — `getting-started`, `platforms`, `security`,
  // `troubleshooting.md`, `changelog.md`, `glossary.md`. The check above
  // tolerates anything that isn't `using/` or `building/` for shared.
  return null;
}

// ---------------------------------------------------------------------------
// 2. Marketing-voice detector
// ---------------------------------------------------------------------------

function checkMarketingVoice(page: Page): void {
  const desc = page.frontMatter.description ?? '';
  for (const phrase of MARKETING_PHRASES) {
    // Word-boundary match so "discover" in the ban list doesn't catch
    // "discovered" as a verb form. The phrases themselves are still
    // case-insensitive — "harness the power" or "Harness The Power" both
    // count.
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i');
    if (re.test(desc)) {
      fail(
        page.relPath,
        `description contains marketing phrase "${phrase}" — banned by DOCS.md §Anti-patterns. Rewrite to state what the page IS, not why to read it.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Stable-anchor check (reference + glossary)
// ---------------------------------------------------------------------------

function checkStableAnchors(page: Page): void {
  // Only enforce on reference pages and the glossary. Tutorials, how-tos,
  // explanations may use auto-generated anchors.
  const isReference = page.frontMatter.kind === 'reference';
  const isGlossary = /(^|\/)glossary\.(md|mdx)$/.test(page.relPath);
  if (!isReference && !isGlossary) return;

  // Skip troubleshooting — it's a reference but FAQ entries are H2-only
  // and the headings are error strings, which include backticks and
  // punctuation that the stable-anchor convention isn't meant for.
  // Required anchors live on the entries themselves and the existing FAQ
  // template enforces them.

  const lines = page.body.split('\n');
  let inCodeBlock = false;
  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;
    // Glossary uses `### Term {#anchor}` shape; both H2 and H3 must carry
    // the explicit id. H1 is owned by the front-matter `title` and never
    // appears in the body per DOCS.md §Cross-page rules.
    const m = line.match(/^##+\s+(.+?)\s*$/);
    if (!m) return;
    // Strip trailing `{#anchor}` and check for its presence.
    const tail = line.match(/\{#[a-z0-9-]+\}\s*$/);
    if (!tail) {
      fail(
        page.relPath,
        `H2/H3 heading "${m[1].trim()}" is missing explicit {#kebab-id} anchor (required on reference + glossary pages — DOCS.md §SEO and AEO).`,
        idx + 1,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Required-sections check (per kind)
// ---------------------------------------------------------------------------

function checkRequiredSections(page: Page): void {
  const kind = page.frontMatter.kind as Kind | undefined;
  if (!kind) return; // already flagged by front-matter check

  // The landing page (`slug: /`) is a hybrid by design — a one-sentence
  // pitch + two-door card grid + before-you-choose links. None of the four
  // kind templates fit it cleanly, and DOCS.md doesn't define a "landing"
  // kind. Skip the section/title-question checks for the landing only.
  if (page.frontMatter.slug === '/') return;

  // tutorial / how-to: simple section name presence.
  const sections = REQUIRED_SECTIONS[kind];
  for (const section of sections) {
    // Match the section as its own line (optionally followed by {#anchor}).
    const re = new RegExp(`^${escapeRegex(section)}(\\s+\\{#[a-z0-9-]+\\})?\\s*$`, 'm');
    if (!re.test(page.body)) {
      fail(page.relPath, `kind: ${kind} requires section "${section}" — missing.`);
    }
  }

  // reference: must have `## Synopsis` OR `## Source`.
  if (kind === 'reference') {
    const hasSynopsis = /^## Synopsis(\s+\{#[a-z0-9-]+\})?\s*$/m.test(page.body);
    const hasSource = /^## Source(\s+\{#[a-z0-9-]+\})?\s*$/m.test(page.body);
    if (!hasSynopsis && !hasSource) {
      fail(
        page.relPath,
        'kind: reference requires either `## Synopsis` or `## Source` — neither found.',
      );
    }
  }

  // explanation: title ends with `?`.
  if (kind === 'explanation') {
    const title = page.frontMatter.title ?? '';
    if (!title.trim().endsWith('?')) {
      fail(
        page.relPath,
        `kind: explanation requires the title to be a "why" question ending with "?". Got: "${title}"`,
      );
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 5. Prohibited-content check
// ---------------------------------------------------------------------------

function checkProhibitedContent(page: Page): void {
  const lines = page.body.split('\n');
  let inCodeBlock = false;

  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;

    for (const phrase of PROHIBITED_BODY_PHRASES) {
      if (line.includes(phrase)) {
        fail(
          page.relPath,
          `Body contains prohibited phrase "${phrase}" — DOCS.md §Anti-patterns.`,
          idx + 1,
        );
      }
    }

    // Emoji in headings — any heading line `^#+ ` with a code point outside
    // the BMP basic-Latin / punctuation range that's commonly an emoji.
    // Conservative test: presence of any high surrogate (D800-DBFF) or
    // common emoji block code points.
    if (/^#{1,6}\s/.test(line)) {
      if (hasEmoji(line)) {
        fail(
          page.relPath,
          `Heading contains emoji — DOCS.md §Anti-patterns: status indicators (✓ / ✗ / ⏳) only, and not in headings.`,
          idx + 1,
        );
      }
    }
  });
}

function hasEmoji(s: string): boolean {
  // Surrogate pair → almost certainly emoji or other extended pictograph.
  if (/[\uD800-\uDBFF]/.test(s)) return true;
  // Common emoji ranges in the BMP that aren't punctuation we already use.
  // 2700-27BF dingbats, 2300-23FF technical, 2600-26FF misc symbols.
  // ✓ ✗ ⏳ are intentionally allowed in body — but not in headings, so this
  // function returns true on ANY heading hit.
  if (/[☀-➿]/.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 6. JSON-LD parse check (against build/)
// ---------------------------------------------------------------------------

function checkJsonLd(pages: Page[]): void {
  if (!existsSync(BUILD_DOCS_DIR)) {
    warn(
      'docs/build',
      'Skipping JSON-LD parse check — build output not found. Run `pnpm --filter docs build` first to enable.',
    );
    return;
  }

  for (const page of pages) {
    const htmlPath = join(DOCS_ROOT, 'build', page.routePath.replace(/^\//, ''), 'index.html');
    if (!existsSync(htmlPath)) continue;
    const html = readFileSync(htmlPath, 'utf8');
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!match) {
      fail(page.relPath, 'Built HTML has no Schema.org JSON-LD block in <head>.');
      continue;
    }
    let parsed: { '@type'?: string };
    try {
      parsed = JSON.parse(match[1]);
    } catch (err) {
      fail(
        page.relPath,
        `Schema.org JSON-LD is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const kind = page.frontMatter.kind as Kind | undefined;
    if (kind && parsed['@type']) {
      const expected = expectedSchemaType(page, kind);
      if (expected && parsed['@type'] !== expected) {
        fail(
          page.relPath,
          `Schema.org @type is "${parsed['@type']}" but kind: ${kind} requires "${expected}".`,
        );
      }
    }
  }
}

function expectedSchemaType(page: Page, kind: Kind): string | null {
  // Special-case troubleshooting + glossary — they get FAQPage / DefinedTermSet.
  if (/(^|\/)troubleshooting\.(md|mdx)$/.test(page.relPath)) return 'FAQPage';
  if (/(^|\/)glossary\.(md|mdx)$/.test(page.relPath)) return 'DefinedTermSet';
  return SCHEMA_TYPE_BY_KIND[kind];
}

// ---------------------------------------------------------------------------
// 7. Length sanity (warnings only)
// ---------------------------------------------------------------------------

function checkLength(page: Page): void {
  const kind = page.frontMatter.kind as Kind | undefined;
  if (!kind) return;
  const lines = page.body.split('\n').length;
  if (lines < LENGTH_MIN_WARN) {
    warn(page.relPath, `Page is only ${lines} body lines — likely a stub.`);
  }
  const ceiling = LENGTH_CEILINGS[kind];
  if (lines > ceiling) {
    warn(
      page.relPath,
      `Page is ${lines} body lines, over the ${kind} ceiling of ${ceiling}. Consider splitting.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Orphan check
// ---------------------------------------------------------------------------

function checkOrphans(pages: Page[]): void {
  // Collect every page id (the docId Docusaurus uses for sidebars).
  const allIds = new Set<string>();
  for (const p of pages) {
    const id = p.relPath.replace(/\.(md|mdx)$/, '').replaceAll(sep, '/');
    allIds.add(id);
  }

  // Pages reachable from sidebars.ts (string-literal scan — sidebars.ts is
  // static config, so this is reliable without evaluating the file).
  const reachable = new Set<string>();
  if (existsSync(SIDEBARS_FILE)) {
    const sidebars = readFileSync(SIDEBARS_FILE, 'utf8');
    const stringLiterals = sidebars.match(/['"][a-z0-9_-]+(?:\/[a-z0-9_-]+)*['"]/g) ?? [];
    for (const literal of stringLiterals) {
      const id = literal.slice(1, -1);
      if (allIds.has(id)) reachable.add(id);
    }
  }

  // Pages reachable via internal links from other pages. Internal links can
  // be repo-relative `.md` paths or in-tree page IDs in MDX-style links.
  for (const p of pages) {
    const links = p.body.match(/\]\(([^)]+)\)/g) ?? [];
    for (const link of links) {
      const target = link.slice(2, -1);
      if (target.startsWith('http') || target.startsWith('#')) continue;
      // Strip anchor + query.
      const path = target.split('#')[0].split('?')[0];
      if (!path) continue;
      const resolved = resolveLinkToId(p, path);
      if (resolved && allIds.has(resolved)) reachable.add(resolved);
    }
  }

  // Pages whose `slug: /` makes them the landing (`intro.md`) are reachable by definition.
  for (const p of pages) {
    if (p.frontMatter.slug === '/') {
      const id = p.relPath.replace(/\.(md|mdx)$/, '').replaceAll(sep, '/');
      reachable.add(id);
    }
  }

  for (const id of allIds) {
    if (!reachable.has(id)) {
      fail(`${id}.md`, 'Orphan page — not reachable from sidebars.ts or any other page.');
    }
  }
}

function resolveLinkToId(from: Page, link: string): string | null {
  // Drop trailing extension. Handle relative paths.
  const fromDir = from.relPath.includes(sep) ? from.relPath.split(sep).slice(0, -1).join('/') : '';
  let path = link.replace(/^\.\//, '');
  // Walk up `..` segments.
  const baseSegments = fromDir.split('/').filter(Boolean);
  while (path.startsWith('../')) {
    baseSegments.pop();
    path = path.slice(3);
  }
  const fullPath = [...baseSegments, path].join('/').replace(/^\/+/, '');
  return fullPath.replace(/\.(md|mdx)$/, '');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const pages = loadPages();

  // Per-page checks.
  for (const page of pages) {
    if (page.frontMatter.agent === false) continue; // opt-out from the gate
    checkFrontMatter(page);
    checkMarketingVoice(page);
    checkStableAnchors(page);
    checkRequiredSections(page);
    checkProhibitedContent(page);
    checkLength(page);
  }

  // Whole-tree checks.
  checkJsonLd(pages);
  checkOrphans(pages);

  // Report.
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
    for (const w of warnings) {
      const loc = w.line ? `${w.file}:${w.line}` : w.file;
      console.log(`  ${loc} — ${w.message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} error${errors.length === 1 ? '' : 's'}:`);
    for (const e of errors) {
      const loc = e.line ? `${e.file}:${e.line}` : e.file;
      console.error(`  ${loc} — ${e.message}`);
    }
    console.error(`\n[docs:check] FAIL — ${errors.length} structural / acceptance violations.`);
    process.exit(1);
  }

  console.log(
    `\n[docs:check] PASS — ${pages.length} pages checked, 0 errors, ${warnings.length} warning${
      warnings.length === 1 ? '' : 's'
    }.`,
  );
}

main();
