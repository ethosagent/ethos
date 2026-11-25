// Inbound Slack file download, moved out of `adapter.ts` (size refactor; no behaviour change).

import type { Attachment, AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { RawSlackFile } from './routing/triage';

/**
 * CHS-006 — hosts a token-bearing file download may target.
 *
 * `url_private_download` comes off an event payload, and the download sends
 * the workspace bot token in an `Authorization` header. Confining the host is
 * what stops a forged or tampered event from pointing that header at an
 * attacker's server; the caller pairs this with `redirect: 'error'`, because a
 * 302 off an allowed host would otherwise carry the token anywhere.
 *
 * Suffix match on a leading dot (plus the bare apex) so `slack.com` and
 * `files.slack.com` pass while `slack.com.evil.test` and `notslack.com` do not.
 */
export function isSlackDownloadUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'slack.com' || host.endsWith('.slack.com');
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'tiff']);
/**
 * Audio uploads are now ADMITTED rather than skipped, and classified as
 * `type: 'audio'`, because channel STT consumes them. Skipping them meant a
 * Slack voice memo never reached transcription at all.
 */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']);
/**
 * Video stays skipped — nothing downstream consumes it. `webm` is ambiguous
 * (it carries either audio or video) and is overwhelmingly video on Slack, so
 * it stays on the skip list rather than being classified as audio.
 */
const SKIP_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv']);

/**
 * Enrich an inbound envelope with file attachments downloaded from Slack.
 * Best-effort: files that fail to download or exceed the size cap are
 * silently skipped. Video files are skipped; audio is admitted as
 * `type: 'audio'` so channel STT can transcribe it.
 */
export async function extractSlackFiles(
  envelope: InboundMessage,
  files: RawSlackFile[],
  deps: {
    cache: AttachmentCache | undefined;
    botKey: string;
    botToken: string;
    maxBytes: number;
  },
): Promise<InboundMessage> {
  const { cache, botKey, botToken, maxBytes } = deps;
  // `recordOnly` returns before the first fetch: the gateway's transcript
  // row is TEXT, so the bytes would be downloaded and cached only to be
  // thrown away — and a third party's file would sit in the attachment cache
  // under a lifetime the transcript's retention never touches. The guard is
  // HERE rather than at the `start()` call site because this is the method a
  // test can reach; `envelope.text` already carries the caption.
  if (!cache || files.length === 0 || envelope.recordOnly) return envelope;

  const attachments: Attachment[] = [];
  const sessionKey = `slack:${botKey}:${envelope.chatId}`;
  const messageId = envelope.messageId ?? String(Date.now());

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = (file.filetype ?? '').toLowerCase();
    if (SKIP_EXTS.has(ext)) continue;
    if ((file.size ?? 0) > maxBytes) continue;
    if (!file.url_private_download) continue;
    // CHS-006 — the URL arrives on an event payload, and the request carries
    // the bot token. Confine it to Slack's own hosts and refuse redirects:
    // otherwise an attacker-controlled `url_private_download` (or a redirect
    // off one) exfiltrates the workspace token in an Authorization header.
    if (!isSlackDownloadUrl(file.url_private_download)) continue;

    const type = IMAGE_EXTS.has(ext)
      ? ('image' as const)
      : AUDIO_EXTS.has(ext)
        ? ('audio' as const)
        : ('file' as const);

    try {
      const res = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: 'error',
      });
      if (!res.ok) continue;
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength > maxBytes) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) continue;
      const filename = file.name ?? `att-${i}`;
      const mime = file.mimetype ?? 'application/octet-stream';
      const url = await cache.write(bytes, {
        sessionKey,
        messageId,
        filename,
        mime,
      });
      attachments.push({
        type,
        ref: `att-${i}`,
        url,
        mimeType: mime,
        filename: file.name,
        sizeBytes: file.size,
      });
    } catch {
      // Download failed — skip this file silently
    }
  }

  if (attachments.length === 0) return envelope;

  return {
    ...envelope,
    attachments,
  };
}
