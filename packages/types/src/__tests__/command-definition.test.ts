import { describe, expect, it } from 'vitest';
import type { CommandDefinition } from '../command';
import { validateCommandDefinition } from '../command';

function makeValid(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return { name: 'test', description: 'A test command', prompt: 'do stuff', ...overrides };
}

describe('validateCommandDefinition', () => {
  it('returns null for a valid prompt-mediated command', () => {
    expect(validateCommandDefinition(makeValid())).toBeNull();
  });

  it('returns null for a valid code command with run', () => {
    const def = makeValid({
      prompt: undefined,
      run: async () => ({ exitCode: 0 }),
    });
    expect(validateCommandDefinition(def)).toBeNull();
  });

  it('rejects having both prompt and run', () => {
    const def = makeValid({
      run: async () => ({ exitCode: 0 }),
    });
    const err = validateCommandDefinition(def);
    expect(err).toContain('exactly one');
  });

  it('rejects having neither prompt nor run', () => {
    const def = makeValid({ prompt: undefined });
    const err = validateCommandDefinition(def);
    expect(err).toContain('exactly one');
  });

  it('rejects empty name', () => {
    const err = validateCommandDefinition(makeValid({ name: '' }));
    expect(err).toContain('name is required');
  });

  it('rejects empty description', () => {
    const err = validateCommandDefinition(makeValid({ description: '' }));
    expect(err).toContain('description is required');
  });

  it('rejects allowedTools with non-string values', () => {
    const def = makeValid({ allowedTools: [42 as unknown as string] });
    const err = validateCommandDefinition(def);
    expect(err).toContain('allowedTools');
  });

  it('accepts valid allowedTools string array', () => {
    const def = makeValid({ allowedTools: ['read_file', 'bash'] });
    expect(validateCommandDefinition(def)).toBeNull();
  });

  it('rejects invalid scope', () => {
    const def = makeValid({ scope: 'bogus' as CommandDefinition['scope'] });
    const err = validateCommandDefinition(def);
    expect(err).toContain('scope');
  });

  it('accepts all valid scopes', () => {
    for (const scope of ['global', 'project', 'personality', 'plugin'] as const) {
      expect(validateCommandDefinition(makeValid({ scope }))).toBeNull();
    }
  });
});
