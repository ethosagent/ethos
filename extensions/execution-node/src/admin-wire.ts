/**
 * Wire shapes of the server's node admin routes (`GET /node/admin/list`, `POST /node/admin/approve`;
 * apps/web-api/src/node/node-admin-routes.ts) with hand-written decoders, so the CLI parses
 * responses without `as` (plan laptop-tool-node verification B4). Pinned by
 * extensions/execution-node/src/__tests__/admin-wire.test.ts.
 */
import { decodeRoots, isRecord, isStringArray, type NodeRootAdvert } from './frames';
import type { NodeListEntry } from './node-hub';

export interface PendingPairing {
  code: string;
  name: string;
  roots: NodeRootAdvert[];
  expiresAt: number;
}
export type ApproveResult =
  | { ok: true; name: string; keyId: string }
  | { ok: false; reason: 'unknown_code' | 'expired' | 'connection_closed' };
export interface NodeAdminList {
  nodes: NodeListEntry[];
  pending: PendingPairing[];
}

function decodeEntry(v: unknown): NodeListEntry | null {
  if (!isRecord(v)) return null;
  const roots = decodeRoots(v.roots);
  if (
    typeof v.name !== 'string' ||
    typeof v.keyId !== 'string' ||
    typeof v.online !== 'boolean' ||
    roots === null ||
    !isStringArray(v.tools) ||
    !isStringArray(v.personalities) ||
    typeof v.lastSeen !== 'string'
  ) {
    return null;
  }
  const entry: NodeListEntry = {
    name: v.name,
    keyId: v.keyId,
    online: v.online,
    roots,
    tools: v.tools,
    personalities: v.personalities,
    lastSeen: v.lastSeen,
  };
  if (typeof v.connectedAt === 'string') entry.connectedAt = v.connectedAt;
  if (typeof v.replacedAt === 'string') entry.replacedAt = v.replacedAt;
  return entry;
}

function decodePending(v: unknown): PendingPairing | null {
  if (!isRecord(v)) return null;
  const roots = decodeRoots(v.roots);
  if (
    typeof v.code !== 'string' ||
    typeof v.name !== 'string' ||
    roots === null ||
    typeof v.expiresAt !== 'number'
  ) {
    return null;
  }
  return { code: v.code, name: v.name, roots, expiresAt: v.expiresAt };
}

export function decodeNodeAdminList(v: unknown): NodeAdminList | null {
  if (!isRecord(v) || !Array.isArray(v.nodes) || !Array.isArray(v.pending)) return null;
  const nodes: NodeListEntry[] = [];
  for (const n of v.nodes) {
    const e = decodeEntry(n);
    if (!e) return null;
    nodes.push(e);
  }
  const pending: PendingPairing[] = [];
  for (const p of v.pending) {
    const d = decodePending(p);
    if (!d) return null;
    pending.push(d);
  }
  return { nodes, pending };
}

export function decodeApproveResult(v: unknown): ApproveResult | null {
  if (!isRecord(v)) return null;
  if (v.ok === true) {
    return typeof v.name === 'string' && typeof v.keyId === 'string'
      ? { ok: true, name: v.name, keyId: v.keyId }
      : null;
  }
  if (
    v.ok === false &&
    (v.reason === 'unknown_code' || v.reason === 'expired' || v.reason === 'connection_closed')
  ) {
    return { ok: false, reason: v.reason };
  }
  return null;
}
