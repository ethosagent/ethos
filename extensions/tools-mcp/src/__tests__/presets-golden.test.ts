import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_PRESETS } from '../presets';
import { MCP_REMOTE_PRESETS } from '../remote-presets';

// Frozen copies of the Phase 0 preset tables, written by a script from the
// live constants (not by hand). Phase 1 (catalog-derived presets) must keep
// these passing UNCHANGED. A pin bump regenerates presets-golden.json with the
// scratchpad script gen-goldens.ts (a tsx script that JSON-stringifies
// MCP_PRESETS, MCP_REMOTE_PRESETS and McpService.catalog(), then biome-formats).
const FIXTURES = join(import.meta.dirname, 'fixtures');
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

describe('preset tables match their frozen goldens', () => {
  it('MCP_PRESETS deep-equals presets-golden.json', () => {
    expect(JSON.parse(JSON.stringify(MCP_PRESETS))).toEqual(read('presets-golden.json'));
  });

  it('MCP_REMOTE_PRESETS deep-equals remote-presets-golden.json', () => {
    expect(JSON.parse(JSON.stringify(MCP_REMOTE_PRESETS))).toEqual(
      read('remote-presets-golden.json'),
    );
  });
});
