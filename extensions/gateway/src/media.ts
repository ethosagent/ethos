import { lstatSync } from 'node:fs';
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
 * Path-based sources are size-checked by the adapter at upload time; this
 * module only guards them for exfiltration safety (see `isSafeMediaPath`).
 */
export const OUTBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB

/**
 * True decoded byte length of a base64 string, accounting for `=` padding and
 * any embedded whitespace. Upper-bound arithmetic (`len * 3 / 4`) over-counts
 * both, which can spuriously reject a payload just under the cap and inflate
 * the reported `sizeBytes` — so we strip whitespace and subtract padding.
 */
function decodedBase64Length(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Reject path-based media sources that could exfiltrate an arbitrary file. A
 * tool that echoes a user-controlled path into `structured` would otherwise
 * become an outbound exfiltration primitive: the adapter reads the path
 * verbatim at upload time. Two vectors are rejected here, degrading to
 * text-only:
 *   - parent-traversal segments (`..`) — a pure string check;
 *   - a path whose final component is a symlink — an indirection to an
 *     arbitrary target, checked with a single `lstat`.
 * A path we cannot stat (missing / no permission) is left to the adapter,
 * which surfaces the real error at upload — there is nothing to exfiltrate
 * from a path that does not resolve.
 *
 * Tool authors MUST NOT put user-controlled paths into structured media.
 */
export function isSafeMediaPath(path: string): boolean {
  if (path.split(/[/\\]/).includes('..')) return false;
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
  } catch {
    // Unstattable path — not a followable symlink; defer to the adapter.
  }
  return true;
}

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
  onReject?: (path: string) => void,
): Attachment[] {
  if (!isOutboundMediaSource(structured)) return [];
  const src = structured;

  const allowed = src.kind === 'image' ? caps.imagesOut : caps.filesOut;
  if (!allowed) return [];

  let url: string;
  let sizeBytes: number | undefined;
  if (typeof src.base64 === 'string') {
    // Enforce the size cap on inline bytes using the TRUE decoded length.
    const decodedLen = decodedBase64Length(src.base64);
    if (decodedLen > maxBytes) return [];
    sizeBytes = decodedLen;
    url = `data:${src.mimeType};base64,${src.base64}`;
  } else if (typeof src.path === 'string') {
    // Guard against an arbitrary-file exfiltration primitive before the path
    // reaches the adapter. Unsafe → degrade to text-only (return []).
    if (!isSafeMediaPath(src.path)) {
      onReject?.(src.path);
      return [];
    }
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
