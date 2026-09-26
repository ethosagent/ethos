import { describe, expect, it } from 'vitest';
import { sheetGroups } from '../character-sheet';

const SHEET = `# engineer — Engineer

Builds things.

I am careful.

## Routing
- Model: claude-sonnet (alias \`fast\`)
- Provider: anthropic
- Dreaming: off

## Memory
- Memory scope: personality:engineer

## Toolset
2 tools:
- read_file
- bash

## MCP servers
- (none)

## Model fit
- Static floor: 1200 tokens (3 tool schemas)
    - prelude: 340 tokens
    - soul: 200 tokens

## Boundary
Register status for this personality.

| Guarantee | Status | For this personality |
|---|---|---|
| G-EXEC    | enforced | sandboxed |
`;

describe('sheetGroups', () => {
  const groups = sheetGroups(SHEET);
  const byTitle = (t: string) => groups.find((g) => g.title === t);

  it('drops the title and prose above the first heading', () => {
    expect(groups.map((g) => g.title)).toEqual([
      'Routing',
      'Memory',
      'Toolset',
      'MCP servers',
      'Model fit',
      'Boundary',
    ]);
  });

  it('splits `- Key: value` bullets into key/value rows', () => {
    expect(byTitle('Routing')?.rows[0]).toEqual({
      key: 'Model',
      value: 'claude-sonnet (alias `fast`)',
      detail: [],
    });
    expect(byTitle('Memory')?.rows[0]?.value).toBe('personality:engineer');
  });

  it('renders the toolset as chips without its count line', () => {
    const toolset = byTitle('Toolset');
    expect(toolset?.kind).toBe('chips');
    expect(toolset?.rows.map((r) => [r.key, r.value])).toEqual([
      [null, 'read_file'],
      [null, 'bash'],
    ]);
  });

  it('a `(none)` group has no rows, so the screen says None.', () => {
    expect(byTitle('MCP servers')?.rows).toEqual([]);
  });

  it('keeps sub-bullets as the row detail', () => {
    expect(byTitle('Model fit')?.rows[0]?.detail).toEqual([
      'prelude: 340 tokens',
      'soul: 200 tokens',
    ]);
  });

  it('turns table rows into key/value rows, skipping header and separator', () => {
    const rows = byTitle('Boundary')?.rows ?? [];
    expect(rows[0]).toEqual({
      key: null,
      value: 'Register status for this personality.',
      detail: [],
    });
    expect(rows[1]).toEqual({ key: 'G-EXEC', value: 'enforced · sandboxed', detail: [] });
    expect(rows).toHaveLength(2);
  });
});
