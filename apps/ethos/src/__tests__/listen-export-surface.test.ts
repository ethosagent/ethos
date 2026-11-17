import { describe, expect, it } from 'vitest';
import type {
  CommandPlaybackDeviceOptions,
  EdgeSttReport,
  EdgeSttResolution,
  ListenCommandDeps,
  ListenFailFlags,
  ListenFlags,
  ListenHeartbeat,
  ListenPreflight,
  ListenStartOptions,
  ListenUrls,
  PlayerKind,
  PlayerProcess,
  PlayerReport,
  PlayerResolution,
  SatelliteLaneProbe,
} from '../commands/listen';

// The type-only exports have no runtime footprint, so this tuple is the compile
// time half of the surface: `pnpm typecheck` fails if one stops being exported.
export type ListenTypeSurface = [
  CommandPlaybackDeviceOptions,
  EdgeSttReport,
  EdgeSttResolution,
  ListenCommandDeps,
  ListenFailFlags,
  ListenFlags,
  ListenHeartbeat,
  ListenPreflight,
  ListenStartOptions,
  ListenUrls,
  PlayerKind,
  PlayerProcess,
  PlayerReport,
  PlayerResolution,
  SatelliteLaneProbe,
];

describe('listen.ts export surface', () => {
  it('exports exactly the pre-split runtime names', async () => {
    const mod = await import('../commands/listen');
    expect(Object.keys(mod).sort()).toEqual([
      'EMPTY_TABLE_WARNING',
      'LANE_PROBE_NAME',
      'USAGE',
      'addressableEntry',
      'capabilityRows',
      'computeListenExit',
      'createCommandPlaybackDevice',
      'deriveListenFailFlags',
      'deriveListenUrls',
      'edgeSttReport',
      'parseListenFlags',
      'playerArgv',
      'probeHealthz',
      'probeSatelliteLane',
      'readSatelliteVadTuning',
      'resolveEdgeSttFrom',
      'resolveListenNodeId',
      'resolvePlayer',
      'resolveRoutePin',
      'runListen',
      'runListenCommand',
      'startListenDaemon',
      'withLaneProbeName',
      'withPipeCaveat',
    ]);
  });
});
