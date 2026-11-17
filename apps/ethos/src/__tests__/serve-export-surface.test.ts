import { describe, expect, it } from 'vitest';
import type {
  BuildServeA2aCoreOptions,
  BuildServeAcpServerOptions,
  BuildServeWebApiOptions,
} from '../commands/serve';

// The type-only exports have no runtime footprint, so this tuple is the compile
// time half of the surface: `pnpm typecheck` fails if one stops being exported.
export type ServeTypeSurface = [
  BuildServeA2aCoreOptions,
  BuildServeAcpServerOptions,
  BuildServeWebApiOptions,
];

describe('serve.ts export surface', () => {
  it('exports exactly the pre-split runtime names', async () => {
    const mod = await import('../commands/serve');
    expect(Object.keys(mod).sort()).toEqual([
      'buildServeA2aCore',
      'buildServeA2aSurface',
      'buildServeAcpServer',
      'buildServeDangerPredicate',
      'buildServeWebApi',
      'locateWebDist',
      'runServe',
      'serveLoopOptions',
    ]);
  });
});
