import { describe, expect, it } from 'vitest';
import { buildMemberLaunchArgs, memberWebPort } from '../supervisor';

describe('memberWebPort', () => {
  it('shifts the ACP port by 10000', () => {
    expect(memberWebPort(3000)).toBe(13000);
  });

  it('subtracts the offset when the shift would overflow', () => {
    expect(memberWebPort(61328)).toBe(51328);
    expect(memberWebPort(60000)).toBe(50000);
  });
});

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
      '--web-port',
      '13010',
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
      '--web-port',
      '13011',
      '--personality',
      'engineer',
      '--mesh',
      'demo',
    ]);
  });
});
