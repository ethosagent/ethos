import type { EthosConfig } from './config-types';

/** `world.*` lines for config.yaml. */
export function worldLines(w: EthosConfig['world']): string[] {
  const lines: string[] = [];
  if (!w) return lines;
  if (w.enabled !== undefined) lines.push(`world.enabled: ${w.enabled}`);
  if (w.contextMaxChars !== undefined) lines.push(`world.contextMaxChars: ${w.contextMaxChars}`);
  if (w.contextHops !== undefined) lines.push(`world.contextHops: ${w.contextHops}`);
  if (w.extraction !== undefined) lines.push(`world.extraction: ${w.extraction}`);
  if (w.proposals?.cap !== undefined) lines.push(`world.proposals.cap: ${w.proposals.cap}`);
  if (w.proposals?.ttlDays !== undefined)
    lines.push(`world.proposals.ttlDays: ${w.proposals.ttlDays}`);
  return lines;
}

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
