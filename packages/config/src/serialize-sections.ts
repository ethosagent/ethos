import type { EthosConfig } from './config-types';

/** `shareLinks.*` lines for config.yaml. */
export function shareLinksLines(sl: EthosConfig['shareLinks']): string[] {
  const lines: string[] = [];
  if (!sl) return lines;
  if (sl.enabled !== undefined) lines.push(`shareLinks.enabled: ${sl.enabled}`);
  if (sl.excludePersonalities && sl.excludePersonalities.length > 0)
    lines.push(`shareLinks.excludePersonalities: ${sl.excludePersonalities.join(',')}`);
  return lines;
}

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
