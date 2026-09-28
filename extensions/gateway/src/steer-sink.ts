import type {
  Attachment,
  AttachmentCache,
  SteerAttachmentBlock,
  SteerEntry,
  SteerSink,
  Storage,
} from '@ethosagent/types';
import { VISION_MAX_BLOCKS_PER_TURN, visionMaxBytesFor } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// The gateway's steer sink (FW-9; UBP-001 / UBP-012)
//
// A message that arrives for a lane whose turn is running is pushed here and
// acked "↩ noted". AgentLoop drains the sink at its tool seam and at text-end
// (`drainSteerEntries`, packages/core/src/agent-loop/steer.ts). What neither
// seam read — a steer pushed after the loop's last drain, or left queued on
// the last allowed iteration — is still here when the turn ends, and
// `Gateway.runTurn` takes it back out (`takeLeftovers`) to run it as its own
// turn instead of letting it close unread with the turn's spool row.
// ---------------------------------------------------------------------------

/** One queued steer and whatever the surface needs to re-run it on its own. */
interface Queued<O> {
  entry: SteerEntry;
  origin: O | undefined;
}

export interface GatewaySteerSink<O> extends SteerSink {
  /** Queue a steer with its attachment blocks and the origin a leftover is
   *  re-run from. `false` when the sink is full. */
  pushEntry(entry: SteerEntry, origin?: O): boolean;
  drainEntries(): SteerEntry[];
  /** Remove and return every steer no seam read, with its origin, in push order. */
  takeLeftovers(): Array<{ entry: SteerEntry; origin: O | undefined }>;
}

export function createSteerSink<O = never>(cap = 32): GatewaySteerSink<O> {
  const queue: Array<Queued<O>> = [];
  const push = (entry: SteerEntry, origin: O | undefined): boolean => {
    if (queue.length >= cap) return false;
    queue.push({ entry, origin });
    return true;
  };
  return {
    push: (text) => push({ text }, undefined),
    pushEntry: (entry, origin) => push(entry, origin),
    drain: () => queue.splice(0).map((q) => q.entry.text),
    drainEntries: () => queue.splice(0).map((q) => q.entry),
    takeLeftovers: () => queue.splice(0),
    depth: () => queue.length,
  };
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MEDIA_TYPE = 'application/pdf';

type ImageMediaType = Extract<SteerAttachmentBlock, { type: 'image' }>['mediaType'];

/**
 * UBP-012 — the image and PDF attachments of a mid-turn message as native
 * blocks, so the model sees the bytes instead of the `(attached image)`
 * placeholder. The caps are the shared vision limits (`visionMaxBytesFor`,
 * `VISION_MAX_BLOCKS_PER_TURN` in packages/types/src/vision-limits.ts), the
 * same numbers the loop's own attachment path applies. More than the per-turn
 * block cap sends none (the placeholder text stands), an oversized or
 * unreadable file is skipped, and anything that is not an image or a PDF is
 * not a block. Whether the turn's model can READ a block is decided at the
 * drain (`steerContentBlocks`, packages/core/src/agent-loop/steer.ts).
 */
export async function steerAttachmentBlocks(
  attachments: readonly Attachment[] | undefined,
  io: { storage?: Storage; attachmentCache?: AttachmentCache },
): Promise<SteerAttachmentBlock[]> {
  const candidates = (attachments ?? []).filter((att) => {
    const mediaType = att.mimeType.toLowerCase();
    return IMAGE_MEDIA_TYPES.has(mediaType) || mediaType === PDF_MEDIA_TYPE;
  });
  if (candidates.length === 0 || candidates.length > VISION_MAX_BLOCKS_PER_TURN) return [];
  const blocks: SteerAttachmentBlock[] = [];
  for (const att of candidates) {
    const mediaType = att.mimeType.toLowerCase();
    const bytes = await readBytes(att, io).catch(() => null);
    if (!bytes || bytes.length > visionMaxBytesFor(mediaType)) continue;
    const data = Buffer.from(bytes).toString('base64');
    const filename = att.filename;
    blocks.push(
      mediaType === PDF_MEDIA_TYPE
        ? { type: 'document', mediaType: PDF_MEDIA_TYPE, data, ...(filename ? { filename } : {}) }
        : {
            type: 'image',
            mediaType: mediaType as ImageMediaType,
            data,
            ...(filename ? { filename } : {}),
          },
    );
  }
  return blocks;
}

/** Bytes behind an attachment URL: the attachment cache (`file://`) or a
 *  `data:` URL. `null` when neither resolves. */
async function readBytes(
  att: Attachment,
  io: { storage?: Storage; attachmentCache?: AttachmentCache },
): Promise<Uint8Array | null> {
  if (att.url.startsWith('file://') && io.attachmentCache && io.storage) {
    return io.storage.readBytes(io.attachmentCache.resolveLocalPath(att.url));
  }
  if (att.url.startsWith('data:')) {
    const comma = att.url.indexOf(',');
    if (comma < 0) return null;
    return Uint8Array.from(Buffer.from(att.url.slice(comma + 1), 'base64'));
  }
  return null;
}
