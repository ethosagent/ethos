import { describe, expect, it } from 'vitest';
import { buildMemberLaunchArgs } from '../supervisor';

describe('supervisor worker launch args', () => {
  it('uses tsx loader for TypeScript entrypoint', () => {
    const args = buildMemberLaunchArgs('/repo/apps/ethos/src/index.ts', 3010, 'researcher', 'demo');
    expect(args).toEqual([
      '--import',
      'tsx',
      '/repo/apps/ethos/src/index.ts',
      'serve',
      '--port',
      '3010',
      '--personality',
      'researcher',
      '--mesh',
      'demo',
    ]);
  });
  it('uses plain node entrypoint for JavaScript binaries', () => {
    const args = buildMemberLaunchArgs(
      '/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js',
      3011,
      'engineer',
      'demo',
    );
    expect(args).toEqual([
      '/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js',
      'serve',
      '--port',
      '3011',
      '--personality',
      'engineer',
      '--mesh',
      'demo',
    ]);
  });
});
