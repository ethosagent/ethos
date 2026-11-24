import type { EthosConfig } from './config-types';

/** `idleWatcher.*` lines for config.yaml (moved verbatim out of serialize.ts, size ratchet). */
export function idleWatcherLines(iw: EthosConfig['idleWatcher']): string[] {
  const lines: string[] = [];
  if (!iw) return lines;
  if (iw.enabled !== undefined) lines.push(`idleWatcher.enabled: ${iw.enabled}`);
  if (iw.idleThresholdMs !== undefined)
    lines.push(`idleWatcher.idleThresholdMs: ${iw.idleThresholdMs}`);
  if (iw.startupCooldownMs !== undefined)
    lines.push(`idleWatcher.startupCooldownMs: ${iw.startupCooldownMs}`);
  if (iw.checkIntervalMs !== undefined)
    lines.push(`idleWatcher.checkIntervalMs: ${iw.checkIntervalMs}`);
  if (iw.wakePathConfirmed !== undefined)
    lines.push(`idleWatcher.wakePathConfirmed: ${iw.wakePathConfirmed}`);
  return lines;
}
