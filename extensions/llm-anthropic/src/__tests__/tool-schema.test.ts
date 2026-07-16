import type { ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { attributeToolSchemaBytes, reduceToolSchemas } from '../tool-schema';

const tools: ToolDefinitionLite[] = [
  {
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'search_files',
    description: 'Search files by pattern.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

describe('Phase 5 — attributeToolSchemaBytes', () => {
  it('per-tool bytes sum to the tools slice total', () => {
    const { perTool, total } = attributeToolSchemaBytes(tools);
    const sum = Object.values(perTool).reduce((a, b) => a + b, 0);
    expect(sum).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it('attributes a byte count to every tool by name', () => {
    const { perTool } = attributeToolSchemaBytes(tools);
    expect(Object.keys(perTool).sort()).toEqual(['read_file', 'search_files']);
    for (const t of tools) expect(perTool[t.name]).toBeGreaterThan(0);
  });
});

describe('Phase 5 — reduceToolSchemas', () => {
  it('strips unused $defs while keeping referenced ones', () => {
    const tool: ToolDefinitionLite = {
      name: 'x',
      description: 'x',
      parameters: {
        type: 'object',
        properties: { a: { $ref: '#/$defs/Used' } },
        $defs: {
          Used: { type: 'string' },
          Dead: { type: 'string', description: 'never referenced, pure overhead' },
        },
      },
    };
    const before = JSON.stringify(tool.parameters).length;
    const [reduced] = reduceToolSchemas([tool]);
    const params = reduced?.parameters as Record<string, unknown>;
    const defs = params.$defs as Record<string, unknown>;
    expect(defs).toHaveProperty('Used');
    expect(defs).not.toHaveProperty('Dead');
    expect(JSON.stringify(reduced?.parameters).length).toBeLessThan(before);
  });

  it('normalizes redundant description whitespace without dropping words', () => {
    const tool: ToolDefinitionLite = {
      name: 'x',
      description: 'First line.   \n\n\n\nSecond line.   ',
      parameters: { type: 'object' },
    };
    const [reduced] = reduceToolSchemas([tool]);
    expect(reduced?.description).toBe('First line.\n\nSecond line.');
    expect(reduced?.description.length).toBeLessThan(tool.description.length);
  });

  it('optionally truncates oversized descriptions but keeps the prefix', () => {
    const tool: ToolDefinitionLite = {
      name: 'x',
      description: 'A'.repeat(500),
      parameters: { type: 'object' },
    };
    const [reduced] = reduceToolSchemas([tool], { maxDescriptionChars: 100 });
    expect(reduced?.description.startsWith('A'.repeat(100))).toBe(true);
    expect(reduced?.description.length).toBeLessThanOrEqual(101);
  });

  it('preserves tool name and required params (tool-calling stays correct)', () => {
    const reduced = reduceToolSchemas(tools);
    expect(reduced.map((t) => t.name)).toEqual(['read_file', 'search_files']);
    const readParams = reduced[0]?.parameters as Record<string, unknown>;
    expect(readParams.required).toEqual(['path']);
    expect(readParams.properties).toHaveProperty('path');
  });

  it('leaves a schema with no dead defs structurally unchanged', () => {
    const [reduced] = reduceToolSchemas(tools);
    expect(reduced?.parameters).toEqual(tools[0]?.parameters);
  });
});
