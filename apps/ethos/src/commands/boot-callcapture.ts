// `ethos boot` — the SINGLE `CallCaptureOwnershipManager` (plan §3c / §11 OQ11),
// split out of boot.ts. Gateway-role, unconditionally: both `gateway.ts` and
// `serve.ts` construct one against the IDENTICAL lock path; in one merged
// process the second construction reads a lock naming its OWN pid,
// `process.kill(pid, 0)` on your own pid always succeeds, so it would report
// `{claimed:false, ownerPid:<mypid>}` forever and permanently disable call
// capture on that path. Hence exactly one, here.
//
// Gateway-role is not a config knob: the gateway's `wake` reaches a real routing
// table (`watcherWakeFn` in boot.ts) while serve's drains the stream with nothing
// consuming it. With zero channel bots configured the two degrade to the same
// drain, so serve-role would be an acceptable substitute; never a better one,
// which is why it is fixed.

import type { EthosConfig } from '@ethosagent/config';
import type { CallCaptureOwnershipManager } from '@ethosagent/platform-callcapture';
import type { Logger, Storage } from '@ethosagent/types';
import type { CreateAgentLoopResult } from '@ethosagent/wiring';
import { callCaptureWake } from '../lib/watcher-wake';
import { CALL_CAPTURE_HEARTBEAT_INTERVAL_MS } from './boot-constants';

export interface BootCallCapture {
  /** Undefined when call capture is off (non-darwin, unbound, or no runner). */
  manager: CallCaptureOwnershipManager | undefined;
  /** True while the daemon is recording. */
  isActive: () => boolean;
}

export async function startBootCallCapture(opts: {
  cfg: EthosConfig;
  dir: string;
  storage: Storage;
  logger: Logger;
  runCallCapture: CreateAgentLoopResult['runCallCapture'];
  watcherWake: Parameters<typeof callCaptureWake>[0];
  /** boot.ts's `() => import('@ethosagent/platform-callcapture')`: the dynamic import stays in boot.ts (archcheck baseline identity). */
  loadModule: () => Promise<typeof import('@ethosagent/platform-callcapture')>;
}): Promise<BootCallCapture> {
  const {
    cfg,
    dir,
    storage,
    logger,
    runCallCapture: captureRunner,
    watcherWake,
    loadModule,
  } = opts;
  let manager: CallCaptureOwnershipManager | undefined;
  let callCaptureState: { kind: string } = { kind: 'idle' };
  if (process.platform === 'darwin' && cfg.callCapture?.personalityId && captureRunner) {
    const {
      CallCaptureDaemon,
      CallCaptureOwnershipManager,
      CaptureIndicator,
      callCaptureHealthPath,
      callCaptureLockPath,
      checkCallCaptureDependencies,
      MicActivityDetector,
      NotificationGate,
    } = await loadModule();
    const boundPersonalityId = cfg.callCapture.personalityId;
    manager = new CallCaptureOwnershipManager({
      lockPath: callCaptureLockPath(dir),
      retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
      logger,
      onOwnershipClaimed: () => {
        const daemon = new CallCaptureDaemon({
          detector: new MicActivityDetector(),
          notificationGate: new NotificationGate(),
          checkDependencies: checkCallCaptureDependencies,
          personalityId: boundPersonalityId,
          // Private by design: the owner's own call audit trail (`callCaptureWake`).
          wake: callCaptureWake(watcherWake),
          indicator: new CaptureIndicator({
            onError: (msg) => logger.warn(`call-capture: ${msg}`),
          }),
          onStateChange: (state) => {
            callCaptureState = state;
          },
          runCapture: async (abortSignal, source, onEntry, onAudioLevel) => {
            const result = await captureRunner(boundPersonalityId, {
              abortSignal,
              source,
              onEntry,
              onAudioLevel,
            });
            if (!result.ok) {
              logger.error(`call-capture: capture failed: ${result.error}`);
              return;
            }
            if (result.warning) logger.warn(`call-capture: ${result.warning}`);
            logger.info(`call-capture: saved transcript to ${result.artifactKey}`);
          },
          logger,
        });
        daemon.start();
        const writeCallCaptureHeartbeat = async () => {
          try {
            await storage.writeAtomic(
              callCaptureHealthPath(dir),
              JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }),
            );
          } catch {
            // Best-effort — a missed tick is harmless.
          }
        };
        void writeCallCaptureHeartbeat();
        const timer = setInterval(
          () => void writeCallCaptureHeartbeat(),
          CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
        );
        timer.unref?.();
        return async () => {
          daemon.stop();
          callCaptureState = { kind: 'idle' };
          clearInterval(timer);
          await storage.remove(callCaptureHealthPath(dir)).catch(() => {});
        };
      },
    });
    manager.start();
  }
  return { manager, isActive: () => callCaptureState.kind !== 'idle' };
}
