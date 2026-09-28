// Pure operations on a self-amendment's ops (plan personality-memory-boundary
// G2, the amendment store). No Storage, no clock: every function here maps
// inputs to outputs, so the intake (filing), `show` and apply compute the SAME
// canonical ops, `opsHash`, after-bytes and `expectedAfterHash` from the same
// inputs.
//
// The `toolset.yaml` text is rendered by `renderToolsetYaml` and read by
// `parseToolsetYaml` from `@ethosagent/types` — the loader's own format owner —
// so the bytes a reviewer approves are the bytes the loader would parse.

import { type AmendmentOp, parseToolsetYaml, renderToolsetYaml } from '@ethosagent/types';
import { sha256Hex } from './store';

/** The tool's `ops` bound (1..10), enforced here too so the store never holds more. */
export const MAX_AMENDMENT_OPS = 10;

/**
 * A tool name an op may carry. Tool names are identifiers; anything else —
 * whitespace, a newline, a `#` — could smuggle a second line into the rendered
 * `toolset.yaml`, so it is refused before rendering, not escaped.
 */
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type AmendmentOpsRefusal =
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'too_many'; count: number }
  | { ok: false; reason: 'invalid_op'; tool: string }
  /** The same tool is both added and removed. */
  | { ok: false; reason: 'conflict'; tool: string }
  /** The live `toolset.yaml` is missing or empty — an undeclared toolset. */
  | { ok: false; reason: 'undeclared_toolset' }
  /** Adding a tool already listed, or removing one that is not. */
  | { ok: false; reason: 'no_op'; tool: string };

const OP_ORDER: Record<AmendmentOp['op'], number> = { add_tool: 0, remove_tool: 1 };

/**
 * Canonical ops: exact duplicates dropped, sorted by tool then op. Refuses an
 * empty list, more than {@link MAX_AMENDMENT_OPS} distinct ops, an unknown op
 * or malformed tool name, and an add and a remove of the same tool.
 */
export function canonicalizeOps(
  ops: readonly AmendmentOp[],
): { ok: true; ops: AmendmentOp[] } | AmendmentOpsRefusal {
  const seen = new Map<string, AmendmentOp>();
  for (const raw of ops) {
    if ((raw.op !== 'add_tool' && raw.op !== 'remove_tool') || !TOOL_NAME.test(raw.tool)) {
      return { ok: false, reason: 'invalid_op', tool: String(raw.tool) };
    }
    seen.set(`${raw.op}\u0000${raw.tool}`, { op: raw.op, tool: raw.tool });
  }
  const canonical = [...seen.values()].sort((a, b) =>
    a.tool === b.tool ? OP_ORDER[a.op] - OP_ORDER[b.op] : a.tool < b.tool ? -1 : 1,
  );
  if (canonical.length === 0) return { ok: false, reason: 'empty' };
  if (canonical.length > MAX_AMENDMENT_OPS) {
    return { ok: false, reason: 'too_many', count: canonical.length };
  }
  for (let i = 1; i < canonical.length; i++) {
    const tool = canonical[i]?.tool;
    if (tool !== undefined && tool === canonical[i - 1]?.tool) {
      return { ok: false, reason: 'conflict', tool };
    }
  }
  return { ok: true, ops: canonical };
}

/** sha256 of the canonical ops' JSON. Callers pass `canonicalizeOps(...).ops`. */
export function opsHash(canonicalOps: readonly AmendmentOp[]): string {
  return sha256Hex(JSON.stringify(canonicalOps.map(({ op, tool }) => ({ op, tool }))));
}

/**
 * The `toolset.yaml` bytes after the ops, from the live bytes.
 *
 * - `null` or `''` is an undeclared toolset (the loader reads both as "no
 *   toolset", every registered built-in tool) and is refused: filing needs a
 *   declared toolset, and an add to "everything" has no meaning.
 * - Removes drop every occurrence; adds append in canonical order after the
 *   surviving tools, which keep their file order.
 * - Any op that would change nothing is refused (`no_op`).
 * - The result is rendered by `renderToolsetYaml`, so a hand-written comment in
 *   the live file is dropped. The review diff shows that.
 */
export function applyOps(
  liveBytes: string | null,
  ops: readonly AmendmentOp[],
): { ok: true; ops: AmendmentOp[]; after: string[]; afterBytes: string } | AmendmentOpsRefusal {
  const canonical = canonicalizeOps(ops);
  if (!canonical.ok) return canonical;
  if (!liveBytes) return { ok: false, reason: 'undeclared_toolset' };

  const before = parseToolsetYaml(liveBytes);
  const present = new Set(before);
  for (const { op, tool } of canonical.ops) {
    if ((op === 'add_tool') === present.has(tool)) return { ok: false, reason: 'no_op', tool };
  }
  const removed = new Set(canonical.ops.filter((o) => o.op === 'remove_tool').map((o) => o.tool));
  const after = [
    ...before.filter((tool) => !removed.has(tool)),
    ...canonical.ops.filter((o) => o.op === 'add_tool').map((o) => o.tool),
  ];
  return { ok: true, ops: canonical.ops, after, afterBytes: renderToolsetYaml(after) };
}

/**
 * `sha256(baseHash ‖ opsHash ‖ afterBytes)` — what the reviewer's `show`
 * prints and apply must reproduce before it writes (G2-5). Both hashes are
 * fixed-width hex, so plain concatenation is unambiguous.
 */
export function expectedAfterHash(baseHash: string, hashOfOps: string, afterBytes: string): string {
  return sha256Hex(`${baseHash}${hashOfOps}${afterBytes}`);
}
