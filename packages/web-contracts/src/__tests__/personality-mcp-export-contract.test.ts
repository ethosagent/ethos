import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from '../index';

// `personalities.update` carries an optional `mcp_export` patch, shallow-merged
// by the registry onto the stored declaration. Every sub-key is optional, so
// `{ enabled: false }` turns export off and keeps the rest.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`contract has no ${field}`);
  return schema;
}

const update = schemaOf(contract.personalities.update, 'inputSchema');
const ok = (mcp_export: unknown) => update.safeParse({ id: 'p', mcp_export }).success;

describe('personalities.update — mcp_export input', () => {
  it('accepts a full declaration and a partial { enabled: false }', () => {
    expect(
      ok({
        enabled: true,
        expose_tools: ['read_file', 'mcp__github__list_issues'],
        expose_memory: 'scoped',
        expose_sessions: true,
        auth: 'bearer',
      }),
    ).toBe(true);
    expect(ok({ enabled: false })).toBe(true);
    expect(ok({ expose_tools: 'all' })).toBe(true);
    expect(ok({ expose_tools: 'none' })).toBe(true);
    expect(update.safeParse({ id: 'p' }).success).toBe(true);
  });

  it('refuses an empty tools array', () => {
    expect(ok({ enabled: true, expose_tools: [] })).toBe(false);
  });

  it('refuses tool names that are not tool-name shaped', () => {
    for (const name of ['', 'read file', 'read_file\nfs_reach.write: /', '"quoted"', '#x']) {
      expect(ok({ expose_tools: [name] }), JSON.stringify(name)).toBe(false);
    }
    expect(ok({ expose_tools: ['x'.repeat(129)] })).toBe(false);
  });

  it('bounds the tools array', () => {
    const many = Array.from({ length: 513 }, (_, i) => `tool_${i}`);
    expect(ok({ expose_tools: many.slice(0, 512) })).toBe(true);
    expect(ok({ expose_tools: many })).toBe(false);
  });

  it('refuses values outside the memory and auth unions', () => {
    expect(ok({ expose_memory: 'read' })).toBe(false);
    expect(ok({ auth: 'oauth' })).toBe(false);
    expect(ok({ expose_sessions: 'yes' })).toBe(false);
    expect(ok({ enabled: 'true' })).toBe(false);
  });
});

describe('personalities.mcpExport — declaration output', () => {
  const output = schemaOf(contract.personalities.mcpExport, 'outputSchema');
  const base = {
    personalityId: 'p',
    exported: false,
    scope: null,
    declarationKeys: [],
    configPath: '~/.ethos/personalities/p/config.yaml',
    command: 'ethos mcp serve --personality p',
    desktopEntry: null,
    clients: [],
    calls: [],
    denials: [],
  };

  it('requires a nullable declaration, loose enough for a hand-written config', () => {
    expect(output.safeParse(base).success).toBe(false);
    expect(output.safeParse({ ...base, declaration: null }).success).toBe(true);
    expect(
      output.safeParse({
        ...base,
        declaration: { enabled: false, expose_tools: ['some/hand-written name'], auth: 'bearer' },
      }).success,
    ).toBe(true);
  });
});
