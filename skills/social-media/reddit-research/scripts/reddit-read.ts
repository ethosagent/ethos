#!/usr/bin/env node
// ---------------------------------------------------------------------------
// reddit-read — Reddit's public Atom feeds: a subreddit listing, or a user's
// recent activity. No credentials, no OAuth, no dependencies.
//
// Scope is deliberately narrow: this implements ONLY the two operations the
// Reddit tools cannot do. Searching is `reddit_search` and reading a thread's
// comment tree is `reddit_thread` (extensions/tools-reddit/); a second
// implementation of either here would be a duplicate path that drifts from the
// first. Prefer those tools whenever they are available — they go through the
// authenticated API and return scores, bodies, and far higher throughput.
//
// Run it directly: `node scripts/reddit-read.ts sub programming --limit 5`.
// SKILL.md documents that invocation as `node ${ETHOS_SKILL_DIR}/scripts/...`
// because `terminal` runs from the workspace, not this directory; the token is
// substituted by `applySubstitutions` in extensions/skills/src/skill-compat.ts.
// Node 24 strips types natively, so there is no build step. Two constraints
// follow from that and must be preserved:
//
//   1. ERASABLE SYNTAX ONLY. Native stripping refuses anything needing a
//      transform — no enums, no namespaces, no parameter properties, no
//      decorators, no `import =`. Type annotations, `interface`, `type` and
//      `satisfies` are all fine. The instinct to reach for an enum here is the
//      one thing that would break `node scripts/reddit-read.ts`.
//   2. ZERO IMPORTS. `fetch`, `process` and `console` are globals in Node 24,
//      so nothing is imported at all — not even a `node:` builtin. That also
//      sidesteps the extensionless-import problem CLAUDE.md flags against
//      `--experimental-strip-types`: that note is about the repo's own
//      cross-module imports under tsx, not a ban on running a self-contained
//      `.ts` file directly, and a file with no imports cannot hit it.
//
// `npx tsx scripts/reddit-read.ts ...` is the fallback for runtimes older than
// Node 22.6.
//
// `console` is correct here: CLAUDE.md bans it in LIBRARY code. This is a
// standalone CLI script whose entire output contract is stdout/stderr, so a
// lint sweep should leave it alone.
// ---------------------------------------------------------------------------

// Reddit blocks generic/missing User-Agent headers. Deliberately kept in sync
// with REDDIT_USER_AGENT in extensions/tools-reddit/src/auth.ts so every Reddit
// request Ethos makes identifies itself the same way.
const USER_AGENT = 'ethos:reddit-search:1.0 (by /u/ethos-agent)';

// A subreddit or username goes straight into a URL path — validate before it
// gets there. Reddit's own limits are narrower than this; this is the outer bound.
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const VALID_SORTS = ['hot', 'new', 'top'];

const DEFAULT_LIMIT = 25;
// Reddit's own server-side ceiling on the feed `limit` parameter. Sent to
// Reddit on every request (see `main`), so this is a reachable bound and not
// just a local cap.
const MAX_LIMIT = 100;

const TITLE_MAX_CHARS = 200;

interface FeedEntry {
  title: string;
  author: string;
  updated: string;
  link: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): never {
  fail(
    'Usage:\n' +
      '  node reddit-read.ts sub NAME [--sort hot|new|top] [--limit N]\n' +
      '  node reddit-read.ts user NAME [--limit N]',
  );
}

/** Decode the handful of XML entities Reddit's Atom output actually emits. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last, so a decoded `&` is not re-decoded
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** First capture group of `pattern` in `xml`, entity-decoded, or ''. */
function captureField(xml: string, pattern: RegExp): string {
  const match = pattern.exec(xml);
  const raw = match?.[1];
  if (!raw) return '';
  return collapseWhitespace(decodeEntities(raw));
}

/**
 * Parse Reddit's Atom feed with a contained regex pass over `<entry>` blocks.
 * This is scoped to the shape Reddit emits (title / author name / updated /
 * link href, no nested entries, no CDATA in those fields) — it is NOT a
 * general-purpose XML parser, and must not be reused as one. A dependency-free
 * script is the whole point; a real parser would cost one.
 *
 * `limit` here is belt-and-braces: the request already asks Reddit for that
 * many (`main` puts it in the query string), and this keeps the contract true
 * if the server ever ignores the parameter.
 */
function parseEntries(xml: string, limit: number): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const entryPattern = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;

  let match = entryPattern.exec(xml);
  while (match !== null && entries.length < limit) {
    const block = match[1] ?? '';

    let title = captureField(block, /<title\b[^>]*>([\s\S]*?)<\/title>/);
    if (title.length > TITLE_MAX_CHARS) title = `${title.slice(0, TITLE_MAX_CHARS)}...`;

    entries.push({
      title,
      author: captureField(block, /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/),
      // Atom timestamps are ISO-8601; the date alone is what a reader needs.
      updated: captureField(block, /<updated\b[^>]*>([\s\S]*?)<\/updated>/).slice(0, 10),
      link: captureField(block, /<link\b[^>]*\bhref="([^"]*)"/),
    });

    match = entryPattern.exec(xml);
  }

  return entries;
}

async function fetchFeed(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (err) {
    fail(`Network error reaching Reddit: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status === 403 || response.status === 429) {
    fail(
      `HTTP ${response.status}: rate-limited or blocked by Reddit (public feeds allow ` +
        `roughly one request per minute per IP). Retry in a minute, or use the ` +
        `reddit_search tool instead.`,
    );
  }
  if (response.status === 404) {
    fail(`HTTP 404: no such subreddit or user (${url}).`);
  }
  if (!response.ok) {
    fail(`HTTP ${response.status}: ${response.statusText} (${url}).`);
  }

  try {
    return await response.text();
  } catch (err) {
    fail(`Could not read Reddit's response: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function printResults(entries: FeedEntry[], heading: string): void {
  if (entries.length === 0) {
    console.log(`${heading}: no entries.`);
    return;
  }

  console.log(`${heading} (${entries.length} entries)`);
  console.log();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    console.log(`${i + 1}. ${entry.title}`);
    console.log(`   ${entry.author || 'unknown author'} | ${entry.updated || 'unknown date'}`);
    console.log(`   ${entry.link}`);
    console.log();
  }
}

interface Options {
  sort: string;
  limit: number;
}

/** Parse `--sort` / `--limit` from the arguments after `<command> <name>`. */
function parseOptions(args: string[], allowSort: boolean): Options {
  let sort = 'hot';
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) fail(`Missing value for ${flag}.`);

    if (flag === '--sort') {
      if (!allowSort) fail('--sort applies to `sub` only.');
      if (!VALID_SORTS.includes(value)) {
        fail(`Invalid --sort '${value}': expected one of ${VALID_SORTS.join(', ')}.`);
      }
      sort = value;
    } else if (flag === '--limit') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        fail(`Invalid --limit '${value}': expected a positive integer.`);
      }
      limit = Math.min(parsed, MAX_LIMIT);
    } else {
      fail(`Unknown option '${flag}'.`);
    }
  }

  return { sort, limit };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const name = argv[1];
  if (command === undefined || name === undefined) usage();
  if (command !== 'sub' && command !== 'user') fail(`Unknown command '${command}'.`);

  if (!NAME_PATTERN.test(name)) {
    fail(
      `Invalid ${command === 'sub' ? 'subreddit' : 'user'} name '${name}': expected 1-64 ` +
        `characters of letters, digits, underscore, or hyphen.`,
    );
  }

  const { sort, limit } = parseOptions(argv.slice(2), command === 'sub');
  const quoted = encodeURIComponent(name);
  // `limit` MUST go to Reddit, not just to parseEntries. Without it the feed
  // returns its default page of 25 whatever was asked for, so a --limit above
  // 25 silently under-delivers — the caller gets 25 entries and nothing says
  // the other 15 were never fetched. Reddit caps the parameter at 100 server
  // side, which is what MAX_LIMIT means.
  const base =
    command === 'sub'
      ? `https://www.reddit.com/r/${quoted}/${sort}/.rss`
      : `https://www.reddit.com/user/${quoted}/.rss`;
  const url = `${base}?limit=${limit}`;

  const entries = parseEntries(await fetchFeed(url), limit);
  const heading = command === 'sub' ? `r/${name} (${sort})` : `u/${name} (recent activity)`;
  printResults(entries, heading);
}

// A rejected promise here would surface as an unhandled rejection — a stack
// trace, which is exactly what every error path above exists to avoid.
main().catch((err: unknown) => {
  fail(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
});
