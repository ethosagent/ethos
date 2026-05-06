// ---------------------------------------------------------------------------
// browser_screenshot tool
// ---------------------------------------------------------------------------

import type { Tool, ToolResult } from '@ethosagent/types';
import { findSessionBySessionId, isPlaywrightInstalled } from './sessions';

export const browserScreenshotTool: Tool = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current browser page. Returns base64-encoded PNG.',
  toolset: 'browser',
  maxResultChars: 500_000,
  isAvailable: isPlaywrightInstalled,
  schema: { type: 'object', properties: {}, required: [] },
  async execute(_, ctx): Promise<ToolResult> {
    const session = findSessionBySessionId(ctx.sessionId);
    if (!session) {
      return {
        ok: false,
        error: 'No active browser session. Call browse_url first.',
        code: 'execution_failed',
      };
    }

    try {
      const screenshot = await session.page.screenshot({ type: 'png' });
      const b64 = screenshot.toString('base64');
      const viewport = session.page.viewportSize() ?? { width: 1280, height: 720 };
      return {
        ok: true,
        value: JSON.stringify({
          image_base64: b64,
          dimensions: viewport,
          url: session.lastUrl,
        }),
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
