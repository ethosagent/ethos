import type { NotificationInstance } from 'antd/es/notification/interface';

/** What `useChat().compact` resolves to: null when there is no session or the RPC failed. */
export type CompactResult = {
  ok: boolean;
  engineName: string;
  droppedCount: number;
  preTotalTokens: number;
  postTotalTokens: number;
  summariesEnabled: boolean;
} | null;

/** Toast the outcome of a manual compaction (`/compact` and the context meter's button). */
export function notifyCompactResult(
  notification: Pick<NotificationInstance, 'info' | 'success'>,
  result: CompactResult,
): void {
  if (!result?.ok) {
    notification.info({
      message: 'Compaction',
      description: 'Not enough history to compact yet.',
    });
    return;
  }
  const saved = Math.max(0, result.preTotalTokens - result.postTotalTokens);
  notification.success({
    message: `Compacted ${result.droppedCount} earlier message(s)`,
    description:
      `${result.engineName}: ${result.preTotalTokens.toLocaleString()} → ` +
      `${result.postTotalTokens.toLocaleString()} tok (−${saved.toLocaleString()})` +
      (result.summariesEnabled
        ? ''
        : '. Summaries disabled — set auxiliary.compression.model to enable.'),
  });
}
