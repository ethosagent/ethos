// ---------------------------------------------------------------------------
// Browser action tools — keyboard, scroll, navigation, console, images, dialogs
// ---------------------------------------------------------------------------

import { lookup } from 'node:dns/promises';
import { validateUrl } from '@ethosagent/safety-network';
import { checkSsrf } from '@ethosagent/tools-web';
import type { Tool, ToolResult } from '@ethosagent/types';
import { getOrCreateSessionWithRoute } from './session-route';
import { closeSession, findActiveSession, isPlaywrightInstalled } from './sessions';
import { snapshotPage } from './snapshot';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// browser_press — Send keyboard keys
// ---------------------------------------------------------------------------

export const browserPressTool: Tool = {
  name: 'browser_press',
  description:
    'Send keyboard keys (Enter, Tab, Escape, ArrowDown, Ctrl+A, etc.). Useful for form submission, navigation, and shortcuts.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description:
          'Key or key combination (e.g. "Enter", "Tab", "Escape", "Control+a", "Meta+c")',
      },
    },
    required: ['key'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { key } = args as { key: string };

    if (!key) return { ok: false, error: 'key is required', code: 'input_invalid' };

    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    try {
      await session.page.keyboard.press(key);
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
// browser_scroll — Scroll the page
// ---------------------------------------------------------------------------

export const browserScrollTool: Tool = {
  name: 'browser_scroll',
  description:
    'Scroll the page in a given direction. Useful for viewing content below the fold or navigating long pages.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels (default 500)',
      },
    },
    required: ['direction'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { direction, amount = 500 } = args as {
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: number;
    };

    if (!direction) return { ok: false, error: 'direction is required', code: 'input_invalid' };

    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    try {
      let x = 0;
      let y = 0;
      switch (direction) {
        case 'up':
          y = -amount;
          break;
        case 'down':
          y = amount;
          break;
        case 'left':
          x = -amount;
          break;
        case 'right':
          x = amount;
          break;
      }

      await session.page.evaluate(([scrollX, scrollY]) => window.scrollBy(scrollX, scrollY), [
        x,
        y,
      ] as [number, number]);
      await session.page.waitForTimeout(300);

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
// browser_back — Navigate back
// ---------------------------------------------------------------------------

export const browserBackTool: Tool = {
  name: 'browser_back',
  description: 'Navigate the browser back to the previous page. Returns the updated page content.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args, ctx): Promise<ToolResult> {
    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    try {
      await session.page.goBack({ timeout: 10_000 });
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
// browser_console — Get console messages
// ---------------------------------------------------------------------------

export const browserConsoleTool: Tool = {
  name: 'browser_console',
  description:
    'Get browser console messages (log, warn, error, etc.) captured since last read. Useful for debugging JavaScript errors and application state.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      clear: {
        type: 'boolean',
        description: 'Clear the buffer after reading (default true)',
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { clear = true } = args as { clear?: boolean };

    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    const logs = session.consoleLogs.join('\n');

    if (clear) {
      session.consoleLogs.length = 0;
    }

    if (!logs) {
      return { ok: true, value: 'No console messages captured.' };
    }

    return { ok: true, value: logs };
  },
};

// ---------------------------------------------------------------------------
// browser_get_images — List all images on page
// ---------------------------------------------------------------------------

export const browserGetImagesTool: Tool = {
  name: 'browser_get_images',
  description:
    'List all images on the current page with their src, alt text, and dimensions. Useful for understanding page media content.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args, ctx): Promise<ToolResult> {
    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    try {
      const images = await session.page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.map((img) => ({
          src: img.src,
          alt: img.alt || '',
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        }));
      });

      if (images.length === 0) {
        return { ok: true, value: 'No images found on page.' };
      }

      const lines = images.map(
        (img, i) =>
          `[${i + 1}] ${img.alt ? `"${img.alt}"` : '(no alt)'} ${img.width}x${img.height} — ${img.src}`,
      );

      return { ok: true, value: `Found ${images.length} image(s):\n\n${lines.join('\n')}` };
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
// browser_dialog — Handle browser dialogs (alert/confirm/prompt)
// ---------------------------------------------------------------------------

export const browserDialogTool: Tool = {
  name: 'browser_dialog',
  description:
    'Handle a pending browser dialog (alert, confirm, prompt). Accept or dismiss the dialog, optionally providing a text value for prompt dialogs.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['accept', 'dismiss'],
        description: 'Whether to accept or dismiss the dialog',
      },
      value: {
        type: 'string',
        description: 'Value to enter for prompt dialogs (only used with action "accept")',
      },
    },
    required: ['action'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { action, value } = args as { action: 'accept' | 'dismiss'; value?: string };

    if (!action) return { ok: false, error: 'action is required', code: 'input_invalid' };

    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    if (session.pendingDialogs.length === 0) {
      return {
        ok: false,
        error: 'No pending dialog to handle.',
        code: 'execution_failed',
      };
    }

    const dialog = session.pendingDialogs.shift();
    if (!dialog) {
      return {
        ok: false,
        error: 'No pending dialog to handle.',
        code: 'execution_failed',
      };
    }

    try {
      if (dialog.handler) {
        await dialog.handler({ accept: action === 'accept', value });
      }

      await session.page.waitForTimeout(300);

      return {
        ok: true,
        value: `Dialog handled: type=${dialog.type}, message="${dialog.message}", action=${action}`,
      };
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
// browser_navigate — Navigate to URL (alias for browse_url, Hermes compat)
// ---------------------------------------------------------------------------

export const browserNavigateTool: Tool = {
  name: 'browser_navigate',
  description:
    'Navigate a browser to a URL and return an accessibility tree with @e{n} element references. Alias for browse_url.',
  toolset: 'browser',
  maxResultChars: 20_000,
  capabilities: {
    network: { allowedHosts: ['*'] },
    process: { allowedBinaries: ['docker'] },
  },
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
      const session = await getOrCreateSessionWithRoute(ctx.sessionId, policy);

      if (ctx.abortSignal.aborted) {
        await closeSession(ctx.sessionId);
        return { ok: false, error: 'Aborted', code: 'execution_failed' };
      }

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
