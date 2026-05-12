/**
 * Emit two agent-readable artifacts from the canonical doc tree:
 *
 *   • docs/static/llms.txt      — Link index. Title + one-line summary + URL
 *                                 per page where `agent !== false`. Under 50KB.
 *   • docs/static/llms-full.txt — Full bodies. Front-matter stripped, MDX
 *                                 components inlined as plain markdown, pages
 *                                 separated by `---`. Under 5MB.
 *
 * Single script, no external deps — front-matter is the simple `key: value`
 * form every Ethos doc uses, so it parses with a tiny hand-rolled reader.
 * Conform to DOCS.md § "Agent-readable surface (two-file + raw-markdown)".
 *
 * Run via `pnpm --filter docs generate:llms` (wired as a `prebuild` step so
 * `pnpm --filter docs build` does the right thing without a second command).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` is undefined when tsx loads the script as CJS, so
// derive the script dir defensively. Works in both CJS (`__dirname`) and
// ESM (`fileURLToPath(import.meta.url)`).
declare const __dirname: string | undefined;
const SCRIPT_DIR =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');
const CONTENT_DIR = join(ROOT, 'content');
const STATIC_DIR = join(ROOT, 'static');
const SITE_URL = 'https://ethosagent.ai';

const LLMS_TXT_BUDGET_BYTES = 50 * 1024;
const LLMS_FULL_BUDGET_BYTES = 5 * 1024 * 1024;

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

// ---------------------------------------------------------------------------
// Front-matter parser — limited to flat `key: value` pairs. Every Ethos doc
// follows that contract per DOCS.md, so a YAML lib is overkill.
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
    let value: string = m[2].trim();
    // Drop wrapping quotes for clean string values.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'agent') {
      frontMatter.agent = value !== 'false';
    } else if (key === 'title') {
      frontMatter.title = value;
    } else if (key === 'description') {
      frontMatter.description = value;
    } else if (key === 'kind') {
      frontMatter.kind = value;
    } else if (key === 'audience') {
      frontMatter.audience = value;
    } else if (key === 'slug') {
      frontMatter.slug = value;
    } else if (key === 'time') {
      frontMatter.time = value;
    } else if (key === 'updated') {
      frontMatter.updated = value;
    }
  }
  return { frontMatter, body: body ?? '' };
}

// ---------------------------------------------------------------------------
// Walk the content tree
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
      out.push(full);
    }
  }
  return out;
}

function routeFor(relPath: string, frontMatter: PageFrontMatter): string {
  if (frontMatter.slug === '/') return '/docs';
  // Docusaurus rule: `slug:` replaces only the LAST path segment.
  // `platforms/slack.md` with `slug: platform-slack` → `/docs/platforms/platform-slack`.
  const segments = relPath
    .replace(/\.(md|mdx)$/, '')
    .replaceAll(sep, '/')
    .split('/');
  if (frontMatter.slug && frontMatter.slug !== segments[segments.length - 1]) {
    segments[segments.length - 1] = frontMatter.slug;
  }
  return `/docs/${segments.join('/')}`;
}

function collectPages(): Page[] {
  const files = walk(CONTENT_DIR);
  const pages: Page[] = [];
  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    const { frontMatter, body } = parseFrontMatter(source);
    if (frontMatter.agent === false) continue;
    const relPath = relative(CONTENT_DIR, filePath);
    pages.push({
      filePath,
      relPath,
      routePath: routeFor(relPath, frontMatter),
      frontMatter,
      body: body.trim(),
    });
  }
  // Stable order — agents that diff the file appreciate alphabetical paths.
  pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return pages;
}

// ---------------------------------------------------------------------------
// llms.txt — link index (≤50KB)
// ---------------------------------------------------------------------------

function renderLinkIndex(pages: Page[]): string {
  const sections: Record<string, Page[]> = {};
  for (const p of pages) {
    const segment = p.relPath.split(sep)[0];
    const bucket = segment.endsWith('.md') || segment.endsWith('.mdx') ? '_root' : segment;
    sections[bucket] = sections[bucket] ?? [];
    sections[bucket].push(p);
  }

  const lines: string[] = [];
  lines.push('# Ethos — agent-readable index');
  lines.push('');
  lines.push(
    'Ethos is a TypeScript agent framework where personality is architecture. This file lists every public docs page; agents follow URLs to fetch raw markdown (every page is also reachable at `<URL>.md`).',
  );
  lines.push('');
  lines.push(`Site root: ${SITE_URL}/docs`);
  lines.push(`Full content: ${SITE_URL}/llms-full.txt`);
  lines.push('');

  const order = ['_root', 'getting-started', 'using', 'building', 'platforms', 'security'];
  const seen = new Set<string>();

  for (const key of order) {
    const bucket = sections[key];
    if (!bucket) continue;
    seen.add(key);
    lines.push(`## ${key === '_root' ? 'Top-level' : titleCase(key)}`);
    lines.push('');
    for (const p of bucket) {
      const title = p.frontMatter.title ?? p.relPath;
      const summary = p.frontMatter.description ?? '';
      lines.push(`- [${title}](${SITE_URL}${p.routePath}) — ${summary}`);
    }
    lines.push('');
  }
  // Any remaining sections that weren't in the canonical order.
  for (const [key, bucket] of Object.entries(sections)) {
    if (seen.has(key)) continue;
    lines.push(`## ${titleCase(key)}`);
    lines.push('');
    for (const p of bucket) {
      const title = p.frontMatter.title ?? p.relPath;
      const summary = p.frontMatter.description ?? '';
      lines.push(`- [${title}](${SITE_URL}${p.routePath}) — ${summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replaceAll('-', ' ');
}

// ---------------------------------------------------------------------------
// llms-full.txt — full content (≤5MB)
// ---------------------------------------------------------------------------

function renderFullContent(pages: Page[]): string {
  const parts: string[] = [];
  parts.push('# Ethos — full documentation corpus');
  parts.push('');
  parts.push(
    'Every page from https://ethosagent.ai/docs concatenated, front-matter stripped, separated by `---`. Each section header lists the canonical URL so an agent can deep-link.',
  );
  parts.push('');

  for (const p of pages) {
    parts.push('---');
    parts.push('');
    parts.push(`# ${p.frontMatter.title ?? p.relPath}`);
    parts.push('');
    parts.push(`Source: ${SITE_URL}${p.routePath}`);
    if (p.frontMatter.kind) parts.push(`Kind: ${p.frontMatter.kind}`);
    if (p.frontMatter.audience) parts.push(`Audience: ${p.frontMatter.audience}`);
    if (p.frontMatter.description) parts.push(`Description: ${p.frontMatter.description}`);
    parts.push('');
    parts.push(stripMdxComments(p.body));
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Remove MDX `{/* … *​/}` comment blocks. Real MDX components are left as-is —
 * agents tolerate JSX in the corpus and removing it would lose context (e.g.
 * the `<dl>` shape of glossary entries that landed before the rewrite).
 */
function stripMdxComments(body: string): string {
  return body.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const pages = collectPages();
  const llmsTxt = renderLinkIndex(pages);
  const llmsFull = renderFullContent(pages);

  // Hard-fail when the index breaches its budget — agents that prefetch
  // llms.txt expect a small, fast file. The full content has more slack but
  // still has a ceiling so the site doesn't ship a 50MB corpus accidentally.
  const txtBytes = Buffer.byteLength(llmsTxt, 'utf8');
  const fullBytes = Buffer.byteLength(llmsFull, 'utf8');
  if (txtBytes > LLMS_TXT_BUDGET_BYTES) {
    throw new Error(
      `llms.txt is ${txtBytes} bytes; budget is ${LLMS_TXT_BUDGET_BYTES} bytes. Trim descriptions or split.`,
    );
  }
  if (fullBytes > LLMS_FULL_BUDGET_BYTES) {
    throw new Error(
      `llms-full.txt is ${fullBytes} bytes; budget is ${LLMS_FULL_BUDGET_BYTES} bytes. Audit page count or split.`,
    );
  }

  mkdirSync(STATIC_DIR, { recursive: true });
  writeFileSync(join(STATIC_DIR, 'llms.txt'), llmsTxt, 'utf8');
  writeFileSync(join(STATIC_DIR, 'llms-full.txt'), llmsFull, 'utf8');

  // Single-line summary so the build log shows what shipped.
  console.log(
    `[llms] wrote ${pages.length} pages → llms.txt (${(txtBytes / 1024).toFixed(1)} KB) · llms-full.txt (${(fullBytes / 1024).toFixed(1)} KB)`,
  );
}

main();
