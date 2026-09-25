// S13 (plan openclaw-2026.9.6-gaps): a browser tool that returns page-authored
// text (an accessibility tree, console output, alt text, a dialog message, an
// element's accessible name) must declare `outputIsUntrusted`, or core never
// fences it (`handleUntrustedResult`, packages/core/src/agent-loop/stages/
// tool-processing.ts). Iterates the whole roster so a tool added later is
// untrusted unless it is named here as framework-shaped.

import type { ClarifyBridge } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { createBrowserTools } from '../index';

// Results built only from framework-authored JSON: a base64 image plus the
// session URL (screenshot), and the takeover hand-back outcome.
const FRAMEWORK_SHAPED = new Set(['browser_screenshot', 'browser_request_takeover']);

describe('browser tools — untrusted output roster (S13)', () => {
  const bridge = {} as ClarifyBridge;
  const roster = createBrowserTools({ clarifyBridge: bridge });

  it.each(roster.filter((t) => !FRAMEWORK_SHAPED.has(t.name)).map((t) => [t.name, t]))(
    '%s declares outputIsUntrusted',
    (_name, tool) => {
      expect(tool.outputIsUntrusted).toBe(true);
    },
  );

  it('names only real roster tools as framework-shaped', () => {
    const names = new Set(roster.map((t) => t.name));
    for (const name of FRAMEWORK_SHAPED) expect(names.has(name)).toBe(true);
  });
});
