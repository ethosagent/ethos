// `ethos listen` — the daemon's heartbeat and context types and the two helpers it
// calls (wire state, auth cookie). Split out of listen.ts. `startListenDaemon`
// itself stays there: it calls runtime exports of `@ethosagent/voice-satellite`,
// and archcheck rule `l5-apps-through-wiring` baselines that import for listen.ts
// only (`.archcheck/baseline.json`, rules in `architecture.config.ts`).

import { ethosDir } from '@ethosagent/config';
import type { Storage, SttProvider } from '@ethosagent/types';
import type { CaptureDevice, CaptureState, PlaybackDevice } from '@ethosagent/voice-satellite';
import type { ListenStartOptions } from './listen-preflight';

/**
 * Same shape as `GatewayHeartbeat`, on purpose.
 *
 * The desktop lane derives satellite status from this file, and it already
 * reads `gateway-health.json`; one reader shape for both is the difference
 * between a status panel and two status panels. `captureState` is the one
 * addition, and it is additive — a reader that only knows the gateway fields
 * still works.
 */
export interface ListenHeartbeat {
  pid: number;
  startedAt: string;
  updatedAt: string;
  adapters: Array<{ name: string; ok: boolean }>;
  captureState: CaptureState;
}

export interface ListenDaemonContext extends ListenStartOptions {
  storage: Storage;
  device: CaptureDevice;
  /**
   * Where the reply is played. Unset is the ORDINARY case, not a test-only one:
   * the daemon builds a command player from `pre.player` when there is one, and
   * a host with neither declares `playback: false` and answers as text.
   */
  playbackDevice?: PlaybackDevice;
  /**
   * The on-device recognizer the preflight constructed. Used only when
   * `pre.edgeStt.enabled` — the two are set from the same resolution, and a
   * daemon that had one without the other would be declaring a capability it
   * cannot perform.
   */
  edgeSttProvider?: SttProvider;
  /**
   * How the process leaves, once the shutdown path has run. Test seam — a test
   * that drove the real `process.exit` would take the runner down with it.
   */
  exit?: (code: number) => void;
}

/** `CaptureState` has more states than the wire does; collapse honestly. */
export function protocolState(
  state: CaptureState,
): 'listening' | 'muted' | 'speaking' | 'degraded' {
  switch (state) {
    case 'muted':
      return 'muted';
    case 'speaking':
      return 'speaking';
    case 'degraded':
      return 'degraded';
    default:
      // idle / listening / capturing / thinking are all "the microphone is
      // armed and this node is in a turn" as far as the indicator is concerned.
      return 'listening';
  }
}

/**
 * The `ethos_auth` cookie the web-api gates `/satellite/ws` behind.
 *
 * Read through `WebTokenRepository` — the same abstraction `ethos serve` and
 * the desktop main process use — so there is exactly one place that knows how
 * the token is minted, stored, and chmod'd. Imported lazily so `listen doctor`
 * does not pay for the web-api module graph.
 */
export async function authCookie(
  storage: Storage,
  // Test seam; defaults to the real `ETHOS_WEB_TOKEN` resolution.
  resolveEnv?: () => string | undefined,
): Promise<{ authCookie?: string }> {
  try {
    const { WebTokenRepository, resolveWebTokenEnv } = await import('@ethosagent/web-api');
    // The server ignores the token file when ETHOS_WEB_TOKEN is set
    // (web-token.repository.ts), so the client must resolve the same token.
    const envToken = resolveEnv ? resolveEnv() : resolveWebTokenEnv();
    const token = await new WebTokenRepository({
      dataDir: ethosDir(),
      storage,
      ...(envToken !== undefined ? { envToken } : {}),
    }).getOrCreate();
    return { authCookie: `ethos_auth=${token}` };
  } catch {
    // No token yet (the web-api has never run here). The upgrade will be
    // refused and the client will retry — which is the right outcome, and a
    // clearer one than a satellite that never says why it cannot connect.
    return {};
  }
}
