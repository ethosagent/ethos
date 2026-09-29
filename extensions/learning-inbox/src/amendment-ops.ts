// Pure operations on a self-amendment's ops (plan personality-memory-boundary
// G2, the amendment store). No Storage, no clock: every function here maps
// inputs to outputs, so the intake (filing), `show` and apply compute the SAME
// canonical ops, `opsHash`, after-bytes and `expectedAfterHash` from the same
// inputs.
//
// The `toolset.yaml` text is rendered by `renderToolsetYaml` and read by
// `parseToolsetYaml` from `@ethosagent/types` — the loader's own format owner —
// so the bytes a reviewer approves are the bytes the loader would parse.

import {
  type AmendmentOp,
  type AmendmentTarget,
  type IdentityAmendmentOp,
  isSingleEmojiGrapheme,
  isToolsetAmendmentOp,
  parseToolsetYaml,
  renderToolsetYaml,
  type ToolsetAmendmentOp,
} from '@ethosagent/types';
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

const OP_ORDER: Record<ToolsetAmendmentOp['op'], number> = { add_tool: 0, remove_tool: 1 };

/**
 * Canonical TOOLSET ops: exact duplicates dropped, sorted by tool then op.
 * Refuses an empty list, more than {@link MAX_AMENDMENT_OPS} distinct ops, an
 * unknown op (an identity op included) or malformed tool name, and an add and
 * a remove of the same tool.
 */
export function canonicalizeOps(
  ops: readonly AmendmentOp[],
): { ok: true; ops: ToolsetAmendmentOp[] } | AmendmentOpsRefusal {
  const seen = new Map<string, ToolsetAmendmentOp>();
  for (const raw of ops) {
    if (!isToolsetAmendmentOp(raw))
      return { ok: false, reason: 'invalid_op', tool: String(raw.op) };
    if (!TOOL_NAME.test(raw.tool)) {
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

/**
 * sha256 of the canonical ops' JSON. Callers pass `canonicalizeOps(...).ops`
 * or `canonicalizeIdentityOps(...).ops`. A toolset op hashes as `{op, tool}`
 * exactly as before the identity target existed, so a stored `opsHash` still
 * matches (rollback compares it).
 */
export function opsHash(canonicalOps: readonly AmendmentOp[]): string {
  return sha256Hex(
    JSON.stringify(
      canonicalOps.map((o) =>
        isToolsetAmendmentOp(o) ? { op: o.op, tool: o.tool } : { op: o.op, value: o.value },
      ),
    ),
  );
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
):
  | { ok: true; ops: ToolsetAmendmentOp[]; after: string[]; afterBytes: string }
  | AmendmentOpsRefusal {
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

// ---------------------------------------------------------------------------
// Identity ops (plan personality-presence-and-initiative §1)
// ---------------------------------------------------------------------------

/** Bounds on an identity op's value, after trimming. */
export const IDENTITY_VALUE_LIMITS = { set_name: 64, set_description: 200 } as const;

const IDENTITY_ORDER: Record<IdentityAmendmentOp['op'], number> = {
  set_name: 0,
  set_description: 1,
  set_display_emoji: 2,
  set_display_avatar: 3,
};

/**
 * A name or vibe line must survive the `config.yaml` round trip byte for byte
 * and show a reviewer every character it carries: one line, and no `"` or `\`
 * (the loader's flat parser strips surrounding quotes but does not unescape,
 * `parseConfigYaml` in extensions/personalities/src/index.ts). A leading or
 * trailing `'` is refused for the same reason. Refused, not escaped — the
 * same rule `TOOL_NAME` applies to a tool.
 *
 * Invisible characters are refused by general category, not by a list, so a
 * new one is covered without an edit: `Cc` (controls, the newline included),
 * `Cf` (format: zero-width and bidi marks, the soft hyphen U+00AD, U+2061–
 * U+2064, the Unicode tag characters U+E0001/U+E0020–U+E007F that can carry a
 * hidden instruction), `Co` (private use), `Cn` (unassigned — U+E0000 among
 * them, as the engine's Unicode tables stand), `Cs` (a lone surrogate, which
 * only matches as one in a `u`-flag regex), and the line and paragraph
 * separators U+2028/U+2029.
 *
 * Some invisible or decorative characters sit in letter, symbol or mark
 * categories, so they are listed by code point: the variation selectors
 * (U+FE00–FE0F, U+E0100–E01EF — they only restyle the character before them,
 * so in a name they are hidden payload), the Hangul fillers (U+115F, U+1160,
 * U+3164, U+FFA0 — `Lo`, render as blank), the braille blank U+2800, and the
 * combining overlays U+0334–U+0338 that strike through the letter they sit on.
 * Plain emoji stay accepted; an emoji written with VS16 (❤️) is not.
 *
 * `MISPLACED_MARK` then refuses a combining mark (`\p{M}`) that is not on a
 * letter — at the start, after a space, a digit, punctuation or a symbol — and
 * a run of more than three marks, which is how stacked "zalgo" text hides one
 * letter under another. Accents (composed or decomposed), Vietnamese double
 * marks and Devanagari vowel signs, viramas and anusvara all sit on a letter
 * or on the mark before it and pass. Pinned by 'canonicalizeIdentityOps —
 * invisible characters' in src/__tests__/amendment-ops.test.ts.
 */
const UNSAFE_TEXT =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u2028\u2029"\\\u115F\u1160\u3164\uFFA0\u2800]|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]|[\u0334-\u0338]/u;
const MISPLACED_MARK = /(?:^|[^\p{L}\p{M}])\p{M}|\p{M}{4}/u;

export type IdentityOpsRefusal =
  | { ok: false; reason: 'empty' }
  /** Not an identity op at all (a toolset op included). */
  | { ok: false; reason: 'invalid_op'; op: string }
  /** An identity op whose value is refused; `detail` says why. */
  | { ok: false; reason: 'invalid_value'; op: IdentityAmendmentOp['op']; detail: string }
  /** Two different values for one field. */
  | { ok: false; reason: 'conflict'; op: IdentityAmendmentOp['op'] };

function identityValueProblem(op: IdentityAmendmentOp): string | null {
  switch (op.op) {
    case 'set_name':
    case 'set_description': {
      const max = IDENTITY_VALUE_LIMITS[op.op];
      if (op.value.length === 0) return 'must not be empty';
      if (op.value.length > max) return `is at most ${max} characters`;
      if (UNSAFE_TEXT.test(op.value) || MISPLACED_MARK.test(op.value)) {
        return 'must be one line with no quotes, backslashes, control or invisible characters';
      }
      if (op.value.startsWith("'") || op.value.endsWith("'")) {
        return 'must not start or end with a quote';
      }
      return null;
    }
    case 'set_display_emoji':
      return isSingleEmojiGrapheme(op.value) ? null : 'must be a single emoji';
    case 'set_display_avatar':
      return op.value === 'generated' || op.value === 'upload'
        ? null
        : "must be 'generated' or 'upload'";
  }
}

/**
 * Canonical IDENTITY ops: values trimmed, exact duplicates dropped, one op per
 * field, ordered name, description, emoji, avatar. Refuses an empty list, an
 * op that is not an identity op, a value {@link identityValueProblem} refuses
 * (the emoji through `isSingleEmojiGrapheme`, the validator `display.emoji`
 * uses everywhere), and two different values for one field.
 */
export function canonicalizeIdentityOps(
  ops: readonly AmendmentOp[],
): { ok: true; ops: IdentityAmendmentOp[] } | IdentityOpsRefusal {
  const byOp = new Map<IdentityAmendmentOp['op'], IdentityAmendmentOp>();
  for (const raw of ops) {
    const kind = (raw as { op?: unknown }).op;
    const value = (raw as { value?: unknown }).value;
    if (typeof kind !== 'string' || !(kind in IDENTITY_ORDER) || typeof value !== 'string') {
      return { ok: false, reason: 'invalid_op', op: String(kind) };
    }
    const op = { op: kind, value: value.trim() } as IdentityAmendmentOp;
    const problem = identityValueProblem(op);
    if (problem) return { ok: false, reason: 'invalid_value', op: op.op, detail: problem };
    const existing = byOp.get(op.op);
    if (existing && existing.value !== op.value)
      return { ok: false, reason: 'conflict', op: op.op };
    byOp.set(op.op, op);
  }
  const canonical = [...byOp.values()].sort((a, b) => IDENTITY_ORDER[a.op] - IDENTITY_ORDER[b.op]);
  if (canonical.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, ops: canonical };
}

/** Human text for an identity refusal — shared by the intake and the store's errors. */
export function describeIdentityOpsRefusal(refusal: IdentityOpsRefusal): string {
  switch (refusal.reason) {
    case 'empty':
      return 'no operations were given';
    case 'invalid_op':
      return `an operation is invalid for an identity amendment (${refusal.op})`;
    case 'invalid_value':
      return `${refusal.op} ${refusal.detail}`;
    case 'conflict':
      return `${refusal.op} is given two different values`;
  }
}

/** Canonical ops for `target`, or the refusal as text. What the store validates with. */
export function canonicalizeAmendmentOps(
  target: AmendmentTarget,
  ops: readonly AmendmentOp[],
): { ok: true; ops: AmendmentOp[] } | { ok: false; reason: string } {
  if (target === 'identity') {
    const identity = canonicalizeIdentityOps(ops);
    return identity.ok ? identity : { ok: false, reason: describeIdentityOpsRefusal(identity) };
  }
  const toolset = canonicalizeOps(ops);
  return toolset.ok ? toolset : { ok: false, reason: toolset.reason };
}
