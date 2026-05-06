import { lookup } from 'node:dns/promises';
import { type NetworkPolicy, validateUrl } from '@ethosagent/safety-network';
import { checkSsrf } from '@ethosagent/tools-web';
import type { Tool, ToolResult } from '@ethosagent/types';
import type { Page } from 'playwright';
import { type A11yRef, parseAriaSnapshot } from './a11y';
import { browserScreenshotTool } from './browser-screenshot';
import { createBrowserVisionClickTool } from './browser-vision-click';
import { createBrowserVisionTypeTool } from './browser-vision-type';
import {
  type BrowserSession,
  closeSession,
  findSessionBySessionId,
  getOrCreateSession,
  isPlaywrightInstalled,
} from './sessions';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

// Tracks which sessions have had their context-level route installed.
// We can't put this on BrowserSession itself without circular imports,
// and the install-once invariant lives at the call-site anyway.
const installedRoutes = new WeakSet<BrowserSession>();

async function getOrCreateSessionWithRoute(
  sessionId: string,
  policy: NetworkPolicy,
): Promise<BrowserSession> {
  const session = await getOrCreateSession(sessionId, policy);
  if (!installedRoutes.has(session)) {
    // Context-level route covers every page in the context. Service
    // workers are blocked at context creation (sessions.ts), so a
    // page can't register one to bypass this check.
    await session.context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
        await route.continue();
        return;
      }
      const check = await validateUrl(reqUrl, policy, resolveHost);
      if (!check.ok) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    installedRoutes.add(session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// Take an accessibility snapshot and format it
// ---------------------------------------------------------------------------

async function snapshotPage(
  page: Page,
): Promise<{ text: string; refs: Map<string, A11yRef>; title: string; url: string }> {
  const title = await page.title();
  const url = page.url();

  // page.locator('body').ariaSnapshot() is the Playwright 1.44+ recommended API.
  // It returns a YAML string; parseAriaSnapshot injects @e{n} refs.
  const yaml = await page.locator('body').ariaSnapshot();
  const { text, refs } = parseAriaSnapshot(yaml);

  return { text, refs, title, url };
}

// ---------------------------------------------------------------------------
// browse_url
// ---------------------------------------------------------------------------

const browseUrlTool: Tool = {
  name: 'browse_url',
  description:
    'Navigate a browser to a URL and return an accessibility tree with @e{n} element references. Use browser_click and browser_type to interact with elements.',
  toolset: 'browser',
  maxResultChars: 20_000,
  outputIsUntrusted: true,
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to' },
      wait_for: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: 'Wait condition (default: domcontentloaded)',
      },
    },
    required: ['url'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { url, wait_for = 'domcontentloaded' } = args as {
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
      return { ok: false, error: 'Only http and https URLs are supported', code: 'input_invalid' };
    }

    // Ch.7 — initial-URL gate. The page.route interceptor below enforces
    // the SAME policy on every redirect target and subresource fetched
    // by Playwright, so the network boundary covers the full navigation
    // (not just `page.goto`'s first request).
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

    try {
      // Session is keyed by (sessionId, policy fingerprint). A policy
      // change tears down and rebuilds the BrowserContext so the page-
      // route handler is fresh and serviceWorkers stay blocked. New
      // sessions install the route on a context-level handler before
      // any page navigation.
      const session = await getOrCreateSessionWithRoute(ctx.sessionId, policy);
      await session.page.goto(url, {
        waitUntil: wait_for,
        timeout: 30_000,
      });
      session.lastUrl = url;

      const { text, refs, title } = await snapshotPage(session.page);
      session.refs = refs;

      const refSummary =
        refs.size > 0
          ? `\n\nInteractive elements (${refs.size}): ${[...refs.keys()].join(', ')}`
          : '';

      const header = `[${title}] ${url}\n\n`;
      return { ok: true, value: header + text + refSummary };
    } catch (err) {
      await closeSession(ctx.sessionId);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// browser_click
// ---------------------------------------------------------------------------

const browserClickTool: Tool = {
  name: 'browser_click',
  description:
    'Click an element in the browser identified by its @e{n} reference from browse_url. Returns the updated page accessibility tree.',
  toolset: 'browser',
  maxResultChars: 20_000,
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      element_ref: {
        type: 'string',
        description: 'Element reference like @e1, @e2, etc.',
      },
    },
    required: ['element_ref'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { element_ref } = args as { element_ref: string };

    if (!element_ref) return { ok: false, error: 'element_ref is required', code: 'input_invalid' };

    const session = findSessionBySessionId(ctx.sessionId);
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    const ref = session.refs.get(element_ref);
    if (!ref) {
      return {
        ok: false,
        error: `Unknown element ref '${element_ref}'. Available: ${[...session.refs.keys()].join(', ') || 'none'}`,
        code: 'input_invalid',
      };
    }

    try {
      await session.page
        // biome-ignore lint/suspicious/noExplicitAny: playwright AriaRole type
        .getByRole(ref.role as any, { name: ref.name })
        .first()
        .click({ timeout: 10_000 });

      // Wait briefly for navigation/re-render
      await session.page.waitForTimeout(500);

      const { text, refs, title, url } = await snapshotPage(session.page);
      session.refs = refs;
      session.lastUrl = url;

      const header = `[${title}] ${url}\n\n`;
      return { ok: true, value: header + text };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// browser_type
// ---------------------------------------------------------------------------

const browserTypeTool: Tool = {
  name: 'browser_type',
  description:
    'Type text into an input element identified by its @e{n} reference. Use browse_url first to get element refs.',
  toolset: 'browser',
  maxResultChars: 20_000,
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      element_ref: {
        type: 'string',
        description: 'Element reference like @e1, @e2, etc.',
      },
      text: {
        type: 'string',
        description: 'Text to type',
      },
      press_enter: {
        type: 'boolean',
        description: 'Press Enter after typing (default false)',
      },
    },
    required: ['element_ref', 'text'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const {
      element_ref,
      text,
      press_enter = false,
    } = args as {
      element_ref: string;
      text: string;
      press_enter?: boolean;
    };

    if (!element_ref) return { ok: false, error: 'element_ref is required', code: 'input_invalid' };
    if (text === undefined) return { ok: false, error: 'text is required', code: 'input_invalid' };

    const session = findSessionBySessionId(ctx.sessionId);
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    const ref = session.refs.get(element_ref);
    if (!ref) {
      return {
        ok: false,
        error: `Unknown element ref '${element_ref}'. Available: ${[...session.refs.keys()].join(', ') || 'none'}`,
        code: 'input_invalid',
      };
    }

    try {
      // biome-ignore lint/suspicious/noExplicitAny: playwright AriaRole type
      const locator = session.page.getByRole(ref.role as any, { name: ref.name }).first();
      await locator.click({ timeout: 10_000 });
      await locator.fill(text);

      if (press_enter) {
        await locator.press('Enter');
        await session.page.waitForTimeout(500);
      }

      const { text: treeText, refs, title, url } = await snapshotPage(session.page);
      session.refs = refs;
      session.lastUrl = url;

      const header = `[${title}] ${url}\n\n`;
      return { ok: true, value: header + treeText };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BrowserToolsOptions {
  visionApiKey?: string;
  visionProvider?: string;
  visionModel?: string;
}

export function createBrowserTools(opts?: BrowserToolsOptions): Tool[] {
  const visionOpts = {
    apiKey: opts?.visionApiKey,
    provider: opts?.visionProvider,
    model: opts?.visionModel,
  };
  return [
    browseUrlTool,
    browserClickTool,
    browserTypeTool,
    browserScreenshotTool,
    createBrowserVisionClickTool(visionOpts),
    createBrowserVisionTypeTool(visionOpts),
  ];
}

export type { A11yRef, A11yResult, RawA11yNode } from './a11y';
export { buildA11yTree, parseAriaSnapshot } from './a11y';
