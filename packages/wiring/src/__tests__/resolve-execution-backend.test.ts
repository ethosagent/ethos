import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveExecutionBackendName } from '../resolve-execution-backend';

function p(extra: Partial<PersonalityConfig> & Record<string, unknown>): PersonalityConfig {
  return { id: 'p', name: 'p', ...extra } as unknown as PersonalityConfig;
}

describe('resolveExecutionBackendName', () => {
  it('selects docker for the terminal tool', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'] }))).toBe('docker');
  });

  it('selects docker for the run_code tool', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['run_code'] }))).toBe('docker');
  });

  it('selects docker for any process_* tool', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['process_start'] }))).toBe('docker');
  });

  it('selects none for a chat-only personality (no exec tool)', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['memory_read', 'web_search'] }))).toBe('none');
  });

  it('selects none when toolset is absent', () => {
    expect(resolveExecutionBackendName(p({}))).toBe('none');
  });

  it('honors an explicit execution override even when an exec tool is present', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'local' }))).toBe(
      'local',
    );
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'none' }))).toBe(
      'none',
    );
  });

  it('ignores an unrecognized execution override and falls back to tool inference', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'bogus' }))).toBe(
      'docker',
    );
  });
});
