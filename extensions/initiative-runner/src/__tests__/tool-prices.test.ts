import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_FREE_READ_TOOLS,
  INITIATIVE_READ_TOOLS,
  INITIATIVE_TOOL_CALL_USD,
  toolCallUsd,
} from '../index';

describe('tool call prices', () => {
  it('every read tool is either priced or on the explicit FREE list, never both', () => {
    const priced = new Set(Object.keys(INITIATIVE_TOOL_CALL_USD));
    const free = new Set<string>(INITIATIVE_FREE_READ_TOOLS);
    for (const name of INITIATIVE_READ_TOOLS) {
      expect(priced.has(name) !== free.has(name), `${name} must be priced xor free`).toBe(true);
    }
    for (const name of [...priced, ...free]) {
      expect(
        (INITIATIVE_READ_TOOLS as readonly string[]).includes(name),
        `${name} is a read tool`,
      ).toBe(true);
    }
  });

  it('a priced tool costs a positive, finite amount; a free or unknown tool costs 0', () => {
    for (const [name, usd] of Object.entries(INITIATIVE_TOOL_CALL_USD)) {
      expect(Number.isFinite(usd) && usd > 0, name).toBe(true);
      expect(toolCallUsd(name)).toBe(usd);
    }
    expect(toolCallUsd('read_file')).toBe(0);
    expect(toolCallUsd('initiative_note')).toBe(0);
  });

  it('the paid web, social-search and answer-engine tools are priced', () => {
    for (const name of ['web_search', 'engine_ask', 'x_search', 'linkedin_search']) {
      expect(toolCallUsd(name), name).toBeGreaterThan(0);
    }
  });
});
