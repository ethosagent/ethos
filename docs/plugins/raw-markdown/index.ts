/**
 * Raw-markdown endpoint — every doc URL `<path>` also resolves at `<path>.md`
 * returning the source markdown with front-matter stripped (no JSX, no
 * Docusaurus chrome). Agents that don't know the per-page convention fall
 * back to `llms-full.txt`; agents that do skip HTML parsing entirely by
 * pulling the raw file.
 *
 * Implementation: `postBuild` walks `docs/content/`, mirrors each `.md` /
 * `.mdx` source into the matching build URL path. Single source of truth
 * stays the canonical markdown — no compile step in between.
 *
 * Per DOCS.md § "Agent-readable surface (two-file + raw-markdown)".
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { LoadContext, Plugin } from '@docusaurus/types';

interface PluginOptions {
  /** Folder under the Docusaurus site root holding the content tree. */
  contentDir?: string;
  /** URL prefix for the docs (matches the Docs plugin's `routeBasePath`). */
  routeBasePath?: string;
}

export default function rawMarkdownPlugin(
  _context: LoadContext,
  options: PluginOptions = {},
): Plugin<unknown> {
  const contentDir = options.contentDir ?? 'content';
  const routeBasePath = options.routeBasePath ?? 'docs';

  return {
    name: 'ethos-raw-markdown',

    async postBuild({ outDir, siteDir }) {
      const sourceRoot = join(siteDir, contentDir);
      const targetRoot = join(outDir, routeBasePath);

      const sources = walk(sourceRoot);
      let written = 0;
      for (const filePath of sources) {
        const rel = relative(sourceRoot, filePath);
        // Convert `.mdx` → `.md` in the served URL; agents look for `.md`
        // either way and we don't want to ship the JSX-flavored extension.
        const targetRel = rel.replace(/\.mdx$/, '.md');
        const target = join(targetRoot, targetRel);

        // Strip front-matter so a `curl` lands clean prose, not the
        // Docusaurus-flavored metadata. Index pages (slug: /) write to
        // `<routeBasePath>.md` AND the route-base index alias.
        const source = readFileSync(filePath, 'utf8');
        const stripped = stripFrontMatter(source);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, stripped, 'utf8');
        written++;

        // Special-case the landing page — its route is `/docs` (slug: /), so
        // it also needs to be reachable at `/docs.md`.
        if (rel === 'intro.md' || rel === 'intro.mdx') {
          const landing = join(outDir, `${routeBasePath}.md`);
          mkdirSync(dirname(landing), { recursive: true });
          copyFileSync(target, landing);
        }
      }
      console.log(`[raw-md] wrote ${written} markdown files into ${routeBasePath}/`);
    },
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.md') || full.endsWith('.mdx')) {
      out.push(full);
    }
  }
  return out;
}

function stripFrontMatter(source: string): string {
  return `${source.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()}\n`;
}
