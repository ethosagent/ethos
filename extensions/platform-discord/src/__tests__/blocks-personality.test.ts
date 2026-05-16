import { describe, expect, it } from 'vitest';
import { personalityEmbed } from '../blocks/personality';

describe('blocks/personality', () => {
  it('builds a personality embed with all fields', () => {
    const result = personalityEmbed({
      name: 'Atlas',
      description: 'A curious explorer',
      model: 'claude-opus-4-6',
      toolset: ['file', 'web', 'terminal'],
    });
    expect(result.title).toBe('Personality');
    const fields = result.fields ?? [];
    expect(fields.some((f) => f.name === 'Name' && f.value.includes('Atlas'))).toBe(true);
    expect(fields.some((f) => f.name === 'Description')).toBe(true);
    expect(fields.some((f) => f.name === 'Model')).toBe(true);
    expect(fields.some((f) => f.name === 'Toolset')).toBe(true);
  });

  it('omits model field when not provided', () => {
    const result = personalityEmbed({
      name: 'Nova',
      description: 'A builder',
    });
    const fields = result.fields ?? [];
    expect(fields.some((f) => f.name === 'Model')).toBe(false);
  });

  it('omits toolset field when empty', () => {
    const result = personalityEmbed({
      name: 'Nova',
      description: 'A builder',
      toolset: [],
    });
    const fields = result.fields ?? [];
    expect(fields.some((f) => f.name === 'Toolset')).toBe(false);
  });

  it('escapes markdown in description', () => {
    const result = personalityEmbed({
      name: 'Test',
      description: 'Uses *bold* and _italic_',
    });
    const descField = result.fields?.find((f) => f.name === 'Description');
    expect(descField?.value).toContain('\\*bold\\*');
  });
});
