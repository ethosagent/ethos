import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSkillDir } from '../skill-dir';

const DATA = '/tmp/ethos-skill-dir';

describe('liveSkillDir', () => {
  it("scope 'personality' resolves to the per-personality skills dir", () => {
    expect(liveSkillDir(DATA, 'agent', 'personality')).toBe(
      join(DATA, 'personalities', 'agent', 'skills'),
    );
  });

  it("scope 'shared' resolves to the shared skills dir", () => {
    expect(liveSkillDir(DATA, 'agent', 'shared')).toBe(join(DATA, 'skills'));
  });

  it('unset scope defaults to the shared skills dir', () => {
    expect(liveSkillDir(DATA, 'agent', undefined)).toBe(join(DATA, 'skills'));
  });

  it('never leaks the personality id into the shared path', () => {
    expect(liveSkillDir(DATA, 'agent', 'shared')).not.toContain('agent');
  });
});
