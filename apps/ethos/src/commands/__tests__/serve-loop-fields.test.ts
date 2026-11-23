import { describe, expect, it } from 'vitest';
import { serveLoopFields } from '../serve-loop';

// Pins the job affinity every serve loop stamps on resumable jobs
// (durable-background-jobs D6): `serve` by default, a team member's own when given.

describe('serveLoopFields jobAffinity', () => {
  it("defaults to 'serve'", () => {
    expect(serveLoopFields({ meshRegistryPath: '/tmp/mesh.json' }).jobAffinity).toBe('serve');
  });

  it('takes a team member override', () => {
    expect(
      serveLoopFields({ meshRegistryPath: '/tmp/mesh.json', jobAffinity: 'serve:alice' })
        .jobAffinity,
    ).toBe('serve:alice');
  });
});
