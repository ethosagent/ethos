/**
 * Per-page Open Graph / Twitter card generator.
 *
 * One PNG per docs page, emitted to `docs/static/img/og/<slug>.png`. Each
 * card is a templated SVG rasterized via sharp; the template carries the
 * Ethos wordmark and accent stripe with the page's title + description
 * laid out for the 1200×630 OG canvas. AI answer cards (Claude, Perplexity,
 * Google AI Mode) and social previews (Twitter, Slack, Discord) pick this
 * image up via the per-page `<meta property="og:image">` injected by the
 * `og-image` postBuild plugin.
 *
 * Runs alongside `generate-llms.ts` as a `prebuild` step. Idempotent — if
 * a card already exists with the same source hash, the rebuild is skipped.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

declare const __dirname: string | undefined;
const SCRIPT_DIR =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');
const CONTENT_DIR = join(ROOT, 'content');
const OUT_DIR = join(ROOT, 'static', 'img', 'og');
const CACHE_FILE = join(OUT_DIR, '.cache.json');

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

// DESIGN.md tokens — accent per persona drives the stripe color.
const ACCENT = {
  default: '#4A9EFF', // researcher blue — also the brand baseline
  user: '#4ADE80', // engineer green — used by using/ tree
  developer: '#94A3B8', // operator grey — used by building/ tree
  shared: '#4A9EFF',
} as const;

interface PageFrontMatter {
  title?: string;
  description?: string;
  audience?: string;
  slug?: string;
  agent?: boolean;
}

interface Page {
  filePath: string;
  relPath: string;
  outputPath: string;
  cacheKey: string;
  frontMatter: PageFrontMatter;
}

// ---------------------------------------------------------------------------
// Walk + parse
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

function parseFrontMatter(source: string): PageFrontMatter {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: PageFrontMatter = {};
  for (const line of match[1].split('\n')) {
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
    else if (key === 'audience') fm.audience = value;
    else if (key === 'slug') fm.slug = value;
  }
  return fm;
}

function cardSlug(relPath: string, fm: PageFrontMatter): string {
  // intro.md (slug: /) becomes 'default' so the global themeConfig.image
  // can point at the same file as the landing's per-page card.
  if (fm.slug === '/') return 'default';
  // Reuse the route segment shape: directories joined by '__' so we get
  // one flat directory of PNGs without recreating the tree.
  return relPath.replace(/\.(md|mdx)$/, '').replaceAll(sep, '__');
}

// ---------------------------------------------------------------------------
// SVG template
// ---------------------------------------------------------------------------

/**
 * 1200×630 card — accent stripe on the left, wordmark top-right, title and
 * description anchored to the lower-left. Geist isn't reliably present in
 * librsvg; we fall back to the platform's sans-serif. The result still
 * reads cleanly at thumbnail size, which is what OG previews actually use.
 */
function renderSvg(title: string, description: string, accent: string): string {
  // Wrap long titles + descriptions so they don't overflow the canvas. The
  // limits here are eyeballed against the 1200×630 layout.
  const titleLines = wrap(title, 28).slice(0, 3);
  const descLines = wrap(description, 70).slice(0, 3);

  const titleTspans = titleLines
    .map((line, i) => `<tspan x="80" dy="${i === 0 ? 0 : 88}">${escapeXml(line)}</tspan>`)
    .join('');
  const descTspans = descLines
    .map((line, i) => `<tspan x="80" dy="${i === 0 ? 0 : 40}">${escapeXml(line)}</tspan>`)
    .join('');

  // Title baseline lands ~360 from top, description ~540, so the stack
  // grows upward into the unused canvas.
  const titleY = 480 - (titleLines.length - 1) * 88;
  const descY = 555;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0F0F0F"/>
  <rect x="0" y="0" width="16" height="${CARD_HEIGHT}" fill="${accent}"/>
  <text x="80" y="120" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="32" font-weight="500" fill="#9A9A98">ethos</text>
  <text x="80" y="${titleY}" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="72" font-weight="600" fill="#E8E8E6" letter-spacing="-1">${titleTspans}</text>
  <text x="80" y="${descY}" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="28" font-weight="400" fill="#9A9A98">${descTspans}</text>
</svg>`;
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// ---------------------------------------------------------------------------
// Cache — skip re-rendering when source content hasn't changed
// ---------------------------------------------------------------------------

function loadCache(): Record<string, string> {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function hashPageInputs(title: string, description: string, accent: string): string {
  return createHash('sha1').update(`${title}\n${description}\n${accent}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const cache = loadCache();
  const nextCache: Record<string, string> = {};

  const files = walk(CONTENT_DIR);
  const pages: Page[] = [];

  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    const frontMatter = parseFrontMatter(source);
    if (frontMatter.agent === false) continue;
    if (!frontMatter.title || !frontMatter.description) continue;
    const relPath = relative(CONTENT_DIR, filePath);
    const slug = cardSlug(relPath, frontMatter);
    const outputPath = join(OUT_DIR, `${slug}.png`);
    const accent =
      ACCENT[(frontMatter.audience ?? 'shared') as keyof typeof ACCENT] ?? ACCENT.shared;
    const cacheKey = hashPageInputs(frontMatter.title, frontMatter.description, accent);
    pages.push({ filePath, relPath, outputPath, cacheKey, frontMatter });
    nextCache[slug] = cacheKey;
  }

  let rendered = 0;
  let skipped = 0;
  for (const page of pages) {
    const slug = page.outputPath.replace(`${OUT_DIR}${sep}`, '').replace(/\.png$/, '');
    if (cache[slug] === page.cacheKey && existsSync(page.outputPath)) {
      skipped++;
      continue;
    }
    const accent =
      ACCENT[(page.frontMatter.audience ?? 'shared') as keyof typeof ACCENT] ?? ACCENT.shared;
    const svg = renderSvg(page.frontMatter.title ?? '', page.frontMatter.description ?? '', accent);
    await sharp(Buffer.from(svg)).png().toFile(page.outputPath);
    rendered++;
  }

  writeFileSync(CACHE_FILE, `${JSON.stringify(nextCache, null, 2)}\n`);
  console.log(`[og] ${rendered} card${rendered === 1 ? '' : 's'} rendered, ${skipped} cached`);
}

void main();
