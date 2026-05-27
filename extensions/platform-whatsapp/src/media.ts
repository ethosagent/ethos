import type { AttachmentCache, Attachment } from '@ethosagent/types';
import type { RawWhatsAppMessage } from './message-parser';
import { getMediaMeta } from './message-parser';

export async function downloadMedia(
  msg: RawWhatsAppMessage,
  downloadFn: (msg: RawWhatsAppMessage) => Promise<Buffer>,
  cache: AttachmentCache,
  sessionKey: string,
): Promise<Attachment | null> {
  const meta = getMediaMeta(msg);
  if (!meta) return null;

  const bytes = await downloadFn(msg);
  const url = await cache.write(new Uint8Array(bytes), {
    sessionKey,
    messageId: msg.key.id ?? `wa-${Date.now()}`,
    filename: meta.filename,
    mime: meta.mime,
  });

  return {
    type: meta.type,
    ref: `wa-${msg.key.id ?? Date.now()}`,
    url,
    mimeType: meta.mime,
    filename: meta.filename,
  };
}
