// UBP-035 — `ethos mcp add` refuses a server name that would put a
// provider-invalid name on every tool the server exposes
// (mcp__<server>__<tool> must match ^[A-Za-z0-9_-]{1,64}$ on OpenAI/Bedrock).
// The refusal happens before mcp.json is read or written.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMcp } from '../commands/mcp';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('ethos mcp add — server name validation', () => {
  for (const bad of ['acme.docs', 'my server', 'a__b', 'trailing_', 'x'.repeat(41)]) {
    it(`refuses '${bad.length > 20 ? `${bad.slice(0, 8)}…` : bad}'`, async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
        errors.push(String(msg));
      });
      await runMcp(['add', bad, '--command', 'npx']);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain(`MCP server name '${bad}'`);
    });
  }
});
