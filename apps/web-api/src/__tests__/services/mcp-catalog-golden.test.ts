import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpService } from '../../services/mcp.service';

// `mcp.catalog` output frozen at Phase 0 (pinned local presets), written from
// McpService.prototype.catalog by a script, not by hand. Phase 1 derives the
// presets from the catalog index and must keep this passing UNCHANGED. A pin
// bump regenerates it with the scratchpad script gen-goldens.ts (see
// extensions/tools-mcp/src/__tests__/presets-golden.test.ts).
const GOLDEN = join(import.meta.dirname, '..', 'fixtures', 'mcp-catalog-golden.json');

describe('McpService.catalog', () => {
  it('deep-equals the Phase 0 golden', () => {
    // catalog() reads no instance state: it returns static preset data.
    const actual = McpService.prototype.catalog.call({});
    expect(JSON.parse(JSON.stringify(actual))).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
