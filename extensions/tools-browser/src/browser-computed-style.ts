// ---------------------------------------------------------------------------
// browser_computed_style — what the page actually renders
// ---------------------------------------------------------------------------
//
// Every other tool in this package answers a question about page STRUCTURE.
// `browse_url` returns an accessibility tree (roles and names, no CSS),
// `web_extract` strips `<style>` and every tag, `browser_screenshot` returns a
// quality-60 JPEG. Nothing reports the styles a visitor actually sees, so a
// caller that wants to know "how many elements wear this colour" has had to
// infer it from parsed stylesheet rules — a summary of a stylesheet, not an
// observation of a page.
//
// This tool loads a URL through the same session machinery as its neighbours
// and reports `getComputedStyle` per ELEMENT. Elements, not roles: N elements
// wearing a colour is a countable fact, and the count is the point.

import { lookup } from 'node:dns/promises';
import { validateUrl } from '@ethosagent/safety-network';
import { checkSsrf } from '@ethosagent/tools-web';
import type { Tool, ToolResult } from '@ethosagent/types';
import { describeBlock, detectBlock } from './block-detector';
import { type BrowserLaunchConfig, buildLaunchOptions } from './launch-options';
import {
  acquireAgentLease,
  closeSession,
  getOrCreateSessionWithRoute,
  isPlaywrightInstalled,
  takeoverRefusalResult,
} from './sessions';
import { snapshotPage } from './snapshot';
import type { BrowserTimeouts } from './timeouts';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * The properties a caller may ask for. FIXED — `properties` is validated
 * against this before it crosses into the page, so a caller cannot widen it.
 *
 * The roster is the set a style consumer actually reads, not everything
 * `getComputedStyle` exposes: it mirrors `SAMPLED_PROPERTIES` in the brand
 * plugin's `adapters/capture/roles.ts`, with that list's two shorthands
 * replaced by the longhands a computed style resolves them into —
 * `background` computes to a nine-part string whose only useful parts are
 * `background-color` / `background-image`, and `border` to
 * `border-color` / `border-width`. `text-transform` is here because the
 * typography analyzer reads it. Anything else is noise a caller would have to
 * filter, and noise costs result budget that evidence needs.
 */
export const COMPUTED_STYLE_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'border-color',
  'border-radius',
  'border-width',
  'box-shadow',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'line-height',
  'padding',
  'text-transform',
] as const;

const ALLOWED_PROPERTIES = new Set<string>(COMPUTED_STYLE_PROPERTIES);

/**
 * The default sweep: one selector per structural role a page presents, tags
 * first because a tag is the one selector every site agrees on, plus the four
 * class conventions (`.btn` / `.button` / `.cta` / `.card`) that the CSS
 * frameworks in wide use share. Deliberately small — a wider default returns
 * the same handful of colours attached to dozens of wrapper `div`s, which
 * costs result budget and buries the elements a reader was asking about.
 * A caller who knows the site passes `selectors` instead.
 */
export const DEFAULT_SELECTORS = [
  'body',
  'header',
  'nav',
  'footer',
  'h1',
  'h2',
  'h3',
  'p',
  'a',
  'button',
  '[type="submit"]',
  '.btn',
  '.button',
  '.cta',
  '.card',
] as const;

/** Caps on what a caller may send into the page. */
const MAX_SELECTORS = 25;
const MAX_SELECTOR_CHARS = 200;
/** Caps on what comes back. `max_elements` defaults low; the budget is hard. */
const DEFAULT_MAX_ELEMENTS = 40;
/**
 * The most elements a caller may ask for.
 *
 * NOT a round number, and not a taste call. `collectComputedStyles` fills its
 * return in SELECTOR order, and `DEFAULT_SELECTORS` puts the six selectors
 * that carry buttons and cards (`button`, `[type="submit"]`, `.btn`,
 * `.button`, `.cta`, `.card`) LAST — behind `p` and `a`, which on a marketing
 * page match dozens each. So a cap is not a sample of the page: a low one
 * returns a page with no button and no card on it whatever the page draws.
 * Measured on https://www.rudderstack.com/, the default sweep matched 179
 * elements and 40 came back; the old ceiling of 100 would still have left 79
 * of them, tail first, unreturned.
 *
 * 120 is what the wire can carry. A fully-populated element record — the
 * fourteen properties above, plus selector and tagName — serialises to about
 * 470 characters, so 120 of them is ~57,000, and `RESULT_BUDGET_CHARS` is
 * sized just above that. Raising the ceiling further would mean a
 * `maxResultChars` above the framework's own 80,000-character per-turn result
 * budget (`AgentLoopConfig.resultBudgetChars`), at which point the registry
 * trims the tail and the JSON stops parsing — the failure `fitToBudget` below
 * exists to prevent.
 */
const MAX_ELEMENTS_CEILING = 120;
/** One value's cap. A `background-image: url(data:...)` is otherwise unbounded. */
const MAX_VALUE_CHARS = 200;
/**
 * Serialized result budget, under the tool's `maxResultChars`.
 *
 * Sized so `MAX_ELEMENTS_CEILING` ordinary elements fit and the ELEMENT CAP is
 * what bounds an ordinary page; the budget stays the backstop for a page whose
 * values run fatter than that allowance (a long font stack, a multi-part
 * shadow, a `background-image` truncated at `MAX_VALUE_CHARS`), where it drops
 * whole records and `truncated` says so.
 *
 * A caller that leaves `max_elements` alone is unaffected by the raise: the
 * collector stops recording at `DEFAULT_MAX_ELEMENTS`, so a default call still
 * serialises to roughly 19,000 characters and still survives being split
 * several ways across parallel tool calls. Only a caller that explicitly asks
 * for more pays more.
 */
const RESULT_BUDGET_CHARS = 60_000;

export interface ComputedStyleElement {
  /** The FIRST selector in the request that matched this element. */
  selector: string;
  tagName: string;
  styles: Record<string, string>;
}

export interface ComputedStyleCollection {
  elements: ComputedStyleElement[];
  /** Distinct rendered elements matched, before `maxElements` truncated them. */
  considered: number;
  /** Selectors the page's own parser rejected. */
  invalidSelectors: string[];
}

export interface CollectComputedStylesInput {
  selectors: string[];
  properties: string[];
  maxElements: number;
  maxValueChars: number;
}

/**
 * Runs INSIDE the page (`page.evaluate`). It is stringified and evaluated
 * there, so it must stay self-contained: it may reference browser globals and
 * its own argument, and nothing else from this module. Every value that
 * reaches it — the selector list and the property names — is validated by
 * `parseComputedStyleArgs` on the Node side first, and arrives as a
 * structured-cloned argument rather than interpolated source, so no caller
 * input is ever executed as code.
 *
 * Exported so `__tests__/browser-computed-style.test.ts` can drive it against
 * a stub document without a browser.
 */
export function collectComputedStyles(input: CollectComputedStylesInput): ComputedStyleCollection {
  const elements: ComputedStyleElement[] = [];
  const invalidSelectors: string[] = [];
  const seen = new Set<Element>();
  let considered = 0;

  for (const selector of input.selectors) {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      invalidSelectors.push(selector);
      continue;
    }
    for (const node of matches) {
      if (seen.has(node)) continue;
      seen.add(node);

      const computed = window.getComputedStyle(node);
      // An element the layout does not draw is not evidence about what a
      // visitor sees — and a hidden template/menu duplicate would inflate
      // exactly the counts this tool exists to make trustworthy.
      if (
        computed.getPropertyValue('display') === 'none' ||
        computed.getPropertyValue('visibility') === 'hidden'
      ) {
        continue;
      }

      considered++;
      if (elements.length >= input.maxElements) continue;

      const styles: Record<string, string> = {};
      for (const property of input.properties) {
        const value = computed.getPropertyValue(property);
        if (!value) continue;
        styles[property] =
          value.length > input.maxValueChars ? `${value.slice(0, input.maxValueChars)}…` : value;
      }
      elements.push({ selector, tagName: node.tagName.toLowerCase(), styles });
    }
  }

  return { elements, considered, invalidSelectors };
}

interface ParsedArgs {
  selectors: string[];
  properties: string[];
  maxElements: number;
}

/**
 * Validates everything that crosses into the page. Exported for tests.
 *
 * A selector is DATA here, never code — but it is still a caller-supplied
 * program the page's selector engine runs, so it is bounded on both count and
 * length: `:has()` chains are the one selector shape whose match cost is not
 * roughly linear, and an unbounded list of them is a page-side stall. A
 * selector the page rejects is reported, not fatal, so one typo does not
 * discard the evidence the other selectors found.
 */
export function parseComputedStyleArgs(args: {
  selectors?: unknown;
  properties?: unknown;
  max_elements?: unknown;
}): { ok: true; value: ParsedArgs } | { ok: false; error: string } {
  let selectors: string[] = [...DEFAULT_SELECTORS];
  if (args.selectors !== undefined) {
    if (!Array.isArray(args.selectors) || args.selectors.length === 0) {
      return { ok: false, error: 'selectors must be a non-empty array of CSS selector strings' };
    }
    if (args.selectors.length > MAX_SELECTORS) {
      return {
        ok: false,
        error: `Too many selectors (${args.selectors.length}). The limit is ${MAX_SELECTORS}.`,
      };
    }
    const cleaned: string[] = [];
    for (const selector of args.selectors) {
      if (typeof selector !== 'string' || selector.trim() === '') {
        return { ok: false, error: 'Every selector must be a non-empty string' };
      }
      if (selector.length > MAX_SELECTOR_CHARS) {
        return {
          ok: false,
          error: `Selector exceeds ${MAX_SELECTOR_CHARS} characters: ${selector.slice(0, 60)}…`,
        };
      }
      cleaned.push(selector.trim());
    }
    selectors = cleaned;
  }

  let properties: string[] = [...COMPUTED_STYLE_PROPERTIES];
  if (args.properties !== undefined) {
    if (!Array.isArray(args.properties) || args.properties.length === 0) {
      return { ok: false, error: 'properties must be a non-empty array of CSS property names' };
    }
    const rejected = args.properties.filter(
      (property) => typeof property !== 'string' || !ALLOWED_PROPERTIES.has(property),
    );
    if (rejected.length > 0) {
      return {
        ok: false,
        error: `Unsupported propert${rejected.length === 1 ? 'y' : 'ies'}: ${rejected.join(', ')}. Allowed: ${[...COMPUTED_STYLE_PROPERTIES].join(', ')}`,
      };
    }
    properties = args.properties as string[];
  }

  const requested = args.max_elements;
  const maxElements =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_ELEMENTS_CEILING, Math.floor(requested)))
      : DEFAULT_MAX_ELEMENTS;

  return { ok: true, value: { selectors, properties, maxElements } };
}

/**
 * Fits the element list to `RESULT_BUDGET_CHARS`, keeping the earliest
 * elements — the selector order the caller asked for. `browse_url` clamps by
 * declaring `maxResultChars` and letting the registry trim the tail, which
 * would leave this tool's JSON unparseable; the same posture, applied to a
 * structured result, means dropping whole records.
 */
function fitToBudget(
  elements: ComputedStyleElement[],
  envelopeChars: number,
): ComputedStyleElement[] {
  const kept: ComputedStyleElement[] = [];
  let used = envelopeChars;
  for (const element of elements) {
    const size = JSON.stringify(element).length + 1;
    if (used + size > RESULT_BUDGET_CHARS) break;
    used += size;
    kept.push(element);
  }
  return kept;
}

export function createBrowserComputedStyleTool(
  timeouts: BrowserTimeouts,
  launchCfg: BrowserLaunchConfig = {},
  escalationTool?: string,
): Tool {
  return {
    name: 'browser_computed_style',
    description:
      'Load a URL and return the computed styles (colour, background, typography, border, shadow) of the real rendered elements on the page, one record per element. Use this when you need evidence about how a page actually looks — such as how many elements carry a colour — rather than its structure.',
    toolset: 'browser',
    maxResultChars: 64_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // browser navigates agent-supplied URLs
      process: { allowedBinaries: ['docker'] },
    },
    outputIsUntrusted: true,
    isAvailable: isPlaywrightInstalled,
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to load' },
        selectors: {
          type: 'array',
          items: { type: 'string' },
          description: `CSS selectors to sample (max ${MAX_SELECTORS}). Default: ${DEFAULT_SELECTORS.join(', ')}`,
        },
        properties: {
          type: 'array',
          items: { type: 'string', enum: [...COMPUTED_STYLE_PROPERTIES] },
          description: `CSS properties to report. Only these are supported: ${COMPUTED_STYLE_PROPERTIES.join(', ')}. Default: all of them.`,
        },
        wait_for: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Wait condition (default: load)',
        },
        max_elements: {
          type: 'number',
          description: `Maximum element records to return (default ${DEFAULT_MAX_ELEMENTS}, ceiling ${MAX_ELEMENTS_CEILING})`,
        },
      },
      required: ['url'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      // `load`, not `domcontentloaded`: a computed style is only worth reading
      // once the stylesheets and webfonts that decide it have arrived.
      const { url, wait_for = 'load' } = args as {
        url: string;
        wait_for?: 'load' | 'domcontentloaded' | 'networkidle';
      };

      if (!url) return { ok: false, error: 'url is required', code: 'input_invalid' };

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: `Invalid URL: ${url}`, code: 'input_invalid' };
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return {
          ok: false,
          error: 'Only http and https URLs are supported',
          code: 'input_invalid',
        };
      }

      const parsedArgs = parseComputedStyleArgs(
        args as { selectors?: unknown; properties?: unknown; max_elements?: unknown },
      );
      if (!parsedArgs.ok) {
        return { ok: false, error: parsedArgs.error, code: 'input_invalid' };
      }
      const { selectors, properties, maxElements } = parsedArgs.value;

      // Same initial-URL gate as browse_url; the context route guard installed
      // by getOrCreateSessionWithRoute enforces the same policy on redirects
      // and subresources.
      const policy = ctx.networkPolicy ?? {};
      const policyCheck = await validateUrl(url, policy, resolveHost);
      if (!policyCheck.ok) {
        return { ok: false, error: policyCheck.reason ?? 'blocked', code: 'execution_failed' };
      }
      const ssrf = await checkSsrf(url);
      if (ssrf.blocked) {
        return { ok: false, error: ssrf.reason, code: 'execution_failed' };
      }

      if (!isPlaywrightInstalled()) {
        return {
          ok: false,
          error: 'Playwright is not installed. Run: npx playwright install chromium',
          code: 'not_available',
        };
      }

      // Declared out here so the `finally` below covers the failure path too —
      // that `catch` calls `closeSession`, and cleanup is part of the
      // operation the lease has to span.
      let release: (() => void) | null = null;
      try {
        const session = await getOrCreateSessionWithRoute(
          ctx.sessionId,
          policy,
          buildLaunchOptions(launchCfg, ctx.personalityId),
        );

        release = acquireAgentLease(ctx.sessionId, session);
        if (!release) return takeoverRefusalResult();

        if (ctx.abortSignal.aborted) {
          await closeSession(ctx.sessionId, release);
          return { ok: false, error: 'Aborted', code: 'execution_failed' };
        }

        const response = await session.page.goto(url, {
          waitUntil: wait_for,
          timeout: timeouts.navigationMs,
        });
        session.lastUrl = url;

        const { text, refs, title } = await snapshotPage(session.page);
        session.refs = refs;

        const notices = session.pendingWarnings.splice(0).map((w) => `⚠ ${w}`);

        // T4 — a bot wall is a SUCCESSFUL navigation to an interstitial, and
        // reporting Cloudflare's palette as the site's is worse than
        // reporting nothing. Same detector, same no-retry posture.
        const blocked = detectBlock({
          ...(response ? { status: response.status(), headers: response.headers() } : {}),
          title,
          text,
        });
        if (blocked) {
          return {
            ok: false,
            error: [...notices, describeBlock(url, blocked, escalationTool)].join('\n'),
            code: 'execution_failed',
          };
        }

        // `page.evaluate` takes no timeout of its own, so the wall clock is
        // put on it here: a selector whose match cost blows up must fail the
        // call rather than hang the turn.
        const collection = await Promise.race([
          session.page.evaluate(collectComputedStyles, {
            selectors,
            properties,
            maxElements,
            maxValueChars: MAX_VALUE_CHARS,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Timed out reading computed styles')),
              timeouts.commandMs,
            ),
          ),
        ]);

        // The whole result is one JSON document, launch notices included — a
        // caller of a structured tool should not have to strip a `⚠` preamble
        // off the front before parsing, the way the a11y-tree tools' text
        // results let them.
        const envelope = {
          url,
          title,
          considered: collection.considered,
          returned: collection.elements.length,
          truncated: false,
          ...(collection.invalidSelectors.length > 0
            ? { invalid_selectors: collection.invalidSelectors }
            : {}),
          ...(notices.length > 0 ? { notices } : {}),
          elements: [] as ComputedStyleElement[],
        };
        const kept = fitToBudget(collection.elements, JSON.stringify(envelope).length);
        envelope.returned = kept.length;
        envelope.truncated = kept.length < collection.considered;
        envelope.elements = kept;

        return { ok: true, value: JSON.stringify(envelope) };
      } catch (err) {
        await closeSession(ctx.sessionId, release);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      } finally {
        release?.();
      }
    },
  };
}
