import type { Attachment } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Outbound media convention (W3.2)
//
// A DOCUMENTED convention on the existing open `ToolResult.structured` field —
// NOT a frozen-schema change. A tool that produces media populates
// `structured` with the recognized shape below; the gateway maps it to
// `OutboundMessage.attachments` when the target adapter's capabilities allow,
// degrading to the plain-text `value` otherwise.
//
//   { kind: 'image' | 'file', path?: string, base64?: string,
//     mimeType: string, filename?: string }
//
// Consumers that don't recognize the shape (or where caps forbid) ignore it —
// the `value` string stays authoritative.
// ---------------------------------------------------------------------------

/** Recognized outbound media source (a convention on `ToolResult.structured`). */
export interface OutboundMediaSource {
  kind: 'image' | 'file';
  path?: string;
  base64?: string;
  mimeType: string;
  filename?: string;
}

/**
 * Outbound media size cap, mirroring the inbound attachment caps. base64
 * payloads over this decoded size are dropped (the text `value` still sends).
 * Path-based sources are not stat'd here (this module stays I/O-free) — the
 * adapter enforces platform limits at upload time.
 */
export const OUTBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB

/** Capabilities gate for outbound media — the adapter's `imagesOut`/`filesOut`. */
export interface OutboundMediaCaps {
  imagesOut: boolean;
  filesOut: boolean;
}

/** Type guard: is `value` the recognized outbound-media shape? */
export function isOutboundMediaSource(value: unknown): value is OutboundMediaSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'image' && v.kind !== 'file') return false;
  if (typeof v.mimeType !== 'string' || v.mimeType.length === 0) return false;
  if (v.path !== undefined && typeof v.path !== 'string') return false;
  if (v.base64 !== undefined && typeof v.base64 !== 'string') return false;
  // Need at least one source of bytes.
  return typeof v.path === 'string' || typeof v.base64 === 'string';
}

/**
 * Map a `ToolResult.structured` payload to outbound `Attachment`s per the media
 * convention. Returns `[]` when the payload isn't recognized media, when the
 * adapter's caps forbid the kind, or when a base64 payload exceeds the size
 * cap — the caller then falls back to the text `value` (graceful degradation).
 *
 * `Attachment.url` carries the transport hint the adapter resolves: a
 * `data:<mime>;base64,<...>` URI for inline bytes, or a local filesystem path.
 */
export function attachmentsFromStructured(
  structured: unknown,
  caps: OutboundMediaCaps,
  maxBytes: number = OUTBOUND_MEDIA_MAX_BYTES,
): Attachment[] {
  if (!isOutboundMediaSource(structured)) return [];
  const src = structured;

  const allowed = src.kind === 'image' ? caps.imagesOut : caps.filesOut;
  if (!allowed) return [];

  let url: string;
  let sizeBytes: number | undefined;
  if (typeof src.base64 === 'string') {
    // Enforce the size cap on inline bytes. base64 decodes to ~3/4 its length.
    const decodedLen = Math.floor((src.base64.length * 3) / 4);
    if (decodedLen > maxBytes) return [];
    sizeBytes = decodedLen;
    url = `data:${src.mimeType};base64,${src.base64}`;
  } else if (typeof src.path === 'string') {
    url = src.path;
  } else {
    return [];
  }

  return [
    {
      type: src.kind,
      ref: src.filename ?? src.path ?? 'attachment',
      url,
      mimeType: src.mimeType,
      ...(src.filename ? { filename: src.filename } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    },
  ];
}

/**
 * Decode an outbound `Attachment.url` into bytes when it is a `data:` URI.
 * Returns `null` for non-data URLs (the adapter treats those as file paths).
 * Shared by adapters so the `data:` vs path convention lives in one place.
 */
export function decodeDataUrl(url: string): { bytes: Uint8Array; mimeType: string } | null {
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m?.[1] || m[2] === undefined) return null;
  return { bytes: Buffer.from(m[2], 'base64'), mimeType: m[1] };
}
