import { describe, expect, it } from 'vitest';
import { buildSupervisorLaunchArgs } from '../team';

describe('team supervisor launch args', () => {
  it('uses tsx loader when entry point is TypeScript', () => {
    const args = buildSupervisorLaunchArgs(
      '/repo/apps/ethos/src/index.ts',
      'demo',
      '/Users/me/.ethos/teams/demo.yaml',
    );
    expect(args).toEqual([
      '--import',
      'tsx',
      '/repo/apps/ethos/src/index.ts',
      '_supervisor',
      'demo',
      '/Users/me/.ethos/teams/demo.yaml',
    ]);
  });

  it('uses plain node entry when entry point is JavaScript', () => {
    const args = buildSupervisorLaunchArgs(
      '/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js',
      'demo',
      '/tmp/demo.yaml',
    );
    expect(args).toEqual([
      '/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js',
      '_supervisor',
      'demo',
      '/tmp/demo.yaml',
    ]);
  });
});
