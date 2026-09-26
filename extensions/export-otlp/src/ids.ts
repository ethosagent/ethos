import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// OTLP id derivation (D4 of plan/phases/otlp-export.md). OTLP trace ids are
// 16 bytes (32 hex chars) and span ids 8 bytes (16 hex chars); Ethos ids are
// free-form strings (UUIDs in practice — `randomUUID()` in
// `ObservabilityService.startTrace`/`startSpan`). Derivation is deterministic
// so a re-export after a lost `markSinkExported` is a same-id resend, which
// id-deduping backends (Tempo, Langfuse) collapse.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * A UUID trace id is already exactly 16 bytes: strip the dashes, lowercase.
 * Any other string is hashed — the first 16 bytes of its sha256.
 */
export function otlpTraceId(traceId: string): string {
  if (UUID_RE.test(traceId)) return traceId.replaceAll('-', '').toLowerCase();
  return sha256Hex(traceId).slice(0, 32);
}

/** First 8 bytes of sha256 — a UUID span id cannot be truncated losslessly. */
export function otlpSpanId(spanId: string): string {
  return sha256Hex(spanId).slice(0, 16);
}

/**
 * The synthetic root span's id, derived from the trace id under a distinct
 * prefix so it can never collide with `otlpSpanId` of a real span.
 */
export function rootSpanId(traceId: string): string {
  return sha256Hex(`root:${traceId}`).slice(0, 16);
}
