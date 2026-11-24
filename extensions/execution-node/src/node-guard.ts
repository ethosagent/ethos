/**
 * NodeGuard — the laptop's admission check for a `call` frame from the server.
 *
 * The server is not trusted: its `fs_reach`, `roomAudience` and `personalityId`
 * are inputs to check, never authority. The guard runs BEFORE any tool executes
 * and before any approval prompt.
 */
import { homedir } from 'node:os';
import { normalize, resolve, sep } from 'node:path';
import { isExistingDirectory, realPathOfLongestExistingAncestor } from '@ethosagent/storage-fs';
import { revealHiddenChars } from '@ethosagent/surface-kit';
import { foldForDeny, type ToolExecuteRequest, type ToolResult } from '@ethosagent/types';
import { NODE_APPROVAL_TIMEOUT_MS, NODE_DEADLINE_GRACE_MS, NODE_MAX_CALL_MS } from './caps';
import { type CallFrame, isRecord, type NodeRoot } from './frames';

export const NODE_FILE_TOOLS = ['read_file', 'write_file', 'patch_file', 'search_files'] as const;
export type NodeBaseTool = (typeof NODE_FILE_TOOLS)[number] | 'terminal';
/** Every tool a node can run: the file tools plus the opt-in terminal. */
export const NODE_BASE_TOOLS: readonly NodeBaseTool[] = [...NODE_FILE_TOOLS, 'terminal'];
export const NODE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'patch_file']);
/** Approval previews show at most this many lines (node-tty.ts renders the same bound). */
export const PREVIEW_MAX_LINES = 20;
const PREVIEW_MAX_BYTES = 1024;
/** Refused (input_invalid) beyond these, so an approval prompt always shows them in full. */
const COMMAND_MAX_BYTES = 8 * 1024;
const PATH_MAX_BYTES = 4 * 1024;
/** More waiting approvals than this and the next call is refused rather than queued. */
const MAX_PENDING_APPROVALS = 8;

export interface NodePolicy {
  /** roots[0] is the primary root (becomes `workingDir`). Absolute + normalized by the caller. */
  roots: NodeRoot[];
  /** Names the node may run (wiring passes `executor.toolNames`). */
  tools: readonly string[];
  /** `['*']` = any personality. */
  personalities: readonly string[];
  writes: 'ask' | 'auto';
  allowUnattended: boolean;
}
/**
 * Every string field is ALREADY sanitised by `NodeGuard` (`sanitizeForPrompt`, once, here): the
 * prompt renderer only folds newlines and must not sanitise again.
 */
export interface ApprovalRequest {
  kind: 'write' | 'command';
  tool: NodeBaseTool;
  personalityId?: string;
  path?: string;
  command?: string;
  cwd?: string;
  summary: string;
  /** Bounded, sanitised preview of what a write changes (write_file content, patch old -> new). */
  preview?: string;
}
/**
 * `signal` aborts when the call is cancelled, times out or the socket drops, or the prompt itself
 * times out: the prompt must dismiss itself. Prompts are serialised by NodeGuard (one at a time).
 */
export type ApprovalPrompt = (req: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
export type CommandCheck = (
  command: string,
) => { dangerous: false } | { dangerous: true; reason: string };
export interface NodeGuardOptions {
  policy: NodePolicy;
  /** null = no TTY: every write/command that needs approval is refused. */
  approve: ApprovalPrompt | null;
  /** Wiring passes tools-terminal's `checkCommand`; absent means terminal is refused. */
  checkCommand?: CommandCheck;
  now?: () => number;
  /** Default `os.homedir()`. */
  home?: string;
}
export type Admission =
  | { ok: true; request: ToolExecuteRequest }
  | { ok: false; result: ToolResult };

const notAvailable = (error: string, reason?: string): Admission => ({
  ok: false,
  result: reason
    ? { ok: false, code: 'not_available', error, reason }
    : { ok: false, code: 'not_available', error },
});
const invalid = (error: string, field?: string): Admission => ({
  ok: false,
  result: field
    ? { ok: false, code: 'input_invalid', error, field }
    : { ok: false, code: 'input_invalid', error },
});
const unreachable = (detail: string): Admission => ({
  ok: false,
  result: { ok: false, code: 'execution_failed', error: `PATH_NOT_REACHABLE: ${detail}` },
});
const failed = (error: string): Admission => ({
  ok: false,
  result: { ok: false, code: 'execution_failed', error },
});

function isNodeBaseTool(name: string): name is NodeBaseTool {
  return name === 'terminal' || (NODE_FILE_TOOLS as readonly string[]).includes(name);
}

function insideRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Deny-direction containment on `foldForDeny` keys (case, NFC/NFD, firmlink spellings). */
export function foldedInsideRoot(p: string, root: string): boolean {
  return insideRoot(foldForDeny(p), foldForDeny(root));
}

/** Format characters (\p{Cf}) the surface-kit list does not cover, shown with the same marker. */
const OTHER_FORMAT_CHARS = /\p{Cf}/gu;

/**
 * Makes node-supplied text safe to show the laptop owner. Strips C0/C1 controls (incl. ESC and CR;
 * keeps \n and \t) so the terminal cannot be steered, then REVEALS hidden characters (bidi
 * overrides, zero-width, tag characters, other \p{Cf}) as visible `⟨U+XXXX⟩` markers instead of
 * hiding them: the owner sees what the text really contains. Pinned by node-guard.test.ts
 * "sanitizeForPrompt".
 */
export function sanitizeForPrompt(s: string): string {
  let stripped = '';
  for (const ch of s) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n < 0x20 && n !== 0x0a && n !== 0x09) || (n >= 0x7f && n <= 0x9f)) continue;
    stripped += ch;
  }
  return revealHiddenChars(stripped).text.replace(
    OTHER_FORMAT_CHARS,
    (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
}

/** Sanitised first 20 lines / 1 KB of `s`; the input is cut first so a huge write costs nothing. */
function boundedPreview(s: string): string {
  const head = s.slice(0, PREVIEW_MAX_BYTES * 4);
  const clean = sanitizeForPrompt(head);
  const lines = clean.split('\n');
  let out = lines.slice(0, PREVIEW_MAX_LINES).join('\n');
  let cut = head.length < s.length || lines.length > PREVIEW_MAX_LINES;
  if (Buffer.byteLength(out) > PREVIEW_MAX_BYTES) {
    out = Buffer.from(out)
      .subarray(0, PREVIEW_MAX_BYTES)
      .toString('utf8')
      .replace(/\uFFFD$/, '');
    cut = true;
  }
  return cut ? `${out}\n[preview truncated]` : out;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').slice(0, 80);
}

/**
 * Admit order (each step refuses before the next runs):
 *  1. callId already seen on this connection (seen entries pruned once their deadline passes)
 *  2. deadline already past, or further ahead than 15 min + grace (not remembered in `seen`)
 *  3. tool not in `policy.tools`
 *  4. roomAudience 'shared'
 *  5. initiator is not 'user' (absent or 'system') without `allowUnattended`
 *  6. personality not permitted
 *  7. argument shape (record args, no `ref`, no NUL in paths)
 *  8. paths: lexical containment in a root, then real-path containment, writes need a writable root
 *  9. terminal: injected `checkCommand` (hardline guard) — dangerous refuses WITHOUT prompting
 * 10. approval: terminal always, writes when `writes === 'ask'`; no TTY, timeout or abort refuses.
 *     Prompts run one at a time in FIFO order; command, path and summary are control-stripped and
 *     write/patch carry a bounded preview (node-guard.test.ts "M5a".."M5d").
 *
 * A `:ro` root wins over a containing writable root on `foldForDeny` keys, so a case or NFC
 * variant spelling cannot reach a write (node-guard.test.ts "M1"; wiring's `nodeWriteDeny`
 * enforces the same at the executor).
 * The order is pinned by extensions/execution-node/src/__tests__/node-guard.test.ts.
 * The `.ssh` sensitive-path floor is NOT this class's job: ScopedFsImpl enforces it (Brief B).
 */
export class NodeGuard {
  private readonly policy: NodePolicy;
  private readonly approve: ApprovalPrompt | null;
  private readonly checkCommand: CommandCheck | undefined;
  private readonly now: () => number;
  private readonly home: string;
  private seen = new Map<string, number>();
  /** The serialiser for approval prompts: one at a time, FIFO (see `ask`). */
  private approvalTail: Promise<void> = Promise.resolve();
  private pendingApprovals = 0;
  /** Real and folded root paths, computed once per connection (`rootInfo`). */
  private roots: Array<{ root: NodeRoot; realRoot: string; folded: string }> | undefined;

  constructor(opts: NodeGuardOptions) {
    this.policy = opts.policy;
    this.approve = opts.approve;
    this.checkCommand = opts.checkCommand;
    this.now = opts.now ?? Date.now;
    this.home = opts.home ?? homedir();
  }

  /** Forget every seen callId and cached root paths — call when a new socket connection starts. */
  newConnection(): void {
    this.seen.clear();
    this.roots = undefined;
  }

  async admit(frame: CallFrame, signal?: AbortSignal): Promise<Admission> {
    const now = this.now();
    for (const [id, deadline] of this.seen) if (deadline < now) this.seen.delete(id);

    if (this.seen.has(frame.callId)) return notAvailable('duplicate callId refused by the node');
    if (frame.deadline > now + NODE_MAX_CALL_MS + NODE_DEADLINE_GRACE_MS) {
      return notAvailable('call deadline is too far ahead');
    }
    this.seen.set(frame.callId, frame.deadline);
    if (frame.deadline < now) return notAvailable('call deadline already passed');

    const req = frame.request;
    const name = req.name;
    if (!isNodeBaseTool(name) || !this.policy.tools.includes(name)) {
      return notAvailable(`tool '${name}' is not enabled on this node`);
    }
    if (req.roomAudience === 'shared')
      return notAvailable('shared-room calls are refused by this node');
    if (req.initiator !== 'user' && !this.policy.allowUnattended) {
      return notAvailable(
        'unattended calls are refused by this node (start it with --allow-unattended)',
      );
    }
    const allowed = this.policy.personalities;
    if (
      !allowed.includes('*') &&
      (req.personalityId === undefined || !allowed.includes(req.personalityId))
    ) {
      return notAvailable(
        `personality '${req.personalityId ?? '(none)'}' is not permitted on this node`,
      );
    }

    const args = req.args;
    if (!isRecord(args)) return invalid('args must be an object');
    // `ref: ''` is an unset optional (strict-schema providers send it; the local read_file treats
    // a falsy ref as absent, extensions/tools-file/src/index.ts), so only a non-empty ref is refused.
    if (name === 'read_file' && args.ref !== undefined && args.ref !== '')
      return invalid('attachments are not available on a node', 'ref');

    const primary = this.policy.roots[0];
    if (!primary) return notAvailable('node has no roots');
    const newArgs: Record<string, unknown> = { ...args };

    if (name === 'terminal') {
      if (typeof args.command !== 'string' || args.command === '')
        return invalid('command is required', 'command');
      if (args.cwd !== undefined && typeof args.cwd !== 'string')
        return invalid('cwd must be a string', 'cwd');
    } else {
      const pathRequired = name !== 'search_files';
      if (args.path !== undefined && typeof args.path !== 'string')
        return invalid('path must be a string', 'path');
      if (pathRequired && args.path === undefined) return invalid('path is required', 'path');
      if (name === 'write_file' && typeof args.content !== 'string')
        return invalid('content is required', 'content');
      if (
        name === 'patch_file' &&
        (typeof args.old_text !== 'string' || typeof args.new_text !== 'string')
      ) {
        return invalid('old_text and new_text are required', 'old_text');
      }
      if (name === 'search_files' && typeof args.pattern !== 'string')
        return invalid('pattern is required', 'pattern');
    }

    const pathKey = name === 'terminal' ? 'cwd' : 'path';
    const rawValue = args[pathKey];
    const raw = typeof rawValue === 'string' ? rawValue : primary.path;
    if (raw.includes('\0')) return invalid(`${pathKey} contains a NUL byte`, pathKey);
    if (Buffer.byteLength(raw) > PATH_MAX_BYTES) {
      return invalid(`${pathKey} is longer than ${PATH_MAX_BYTES} bytes`, pathKey);
    }
    if (name === 'terminal' && Buffer.byteLength(String(args.command)) > COMMAND_MAX_BYTES) {
      return invalid(`command is longer than ${COMMAND_MAX_BYTES} bytes`, 'command');
    }

    const checked = this.checkPath(
      raw,
      primary.path,
      NODE_WRITE_TOOLS.has(name),
      name === 'terminal',
    );
    if (!checked.ok) return checked.refusal;
    newArgs[pathKey] = checked.abs;

    let command: string | undefined;
    if (name === 'terminal') {
      command = String(args.command);
      if (!this.checkCommand) return notAvailable('terminal guard not wired on this node');
      const verdict = this.checkCommand(command);
      if (verdict.dangerous)
        return failed(`command refused by the node's safety guard: ${verdict.reason}`);
    }

    const needsApproval =
      name === 'terminal' || (NODE_WRITE_TOOLS.has(name) && this.policy.writes === 'ask');
    if (needsApproval) {
      const preview = name === 'terminal' ? '' : previewOf(name, args);
      const approval: ApprovalRequest =
        name === 'terminal'
          ? {
              kind: 'command',
              tool: name,
              command: sanitizeForPrompt(command ?? ''),
              cwd: sanitizeForPrompt(checked.abs),
              summary: sanitizeForPrompt(firstLine(command ?? '')),
            }
          : {
              kind: 'write',
              tool: name,
              path: sanitizeForPrompt(checked.abs),
              summary: sanitizeForPrompt(summarize(name, args)),
              ...(preview !== '' && { preview }),
            };
      if (req.personalityId !== undefined) {
        approval.personalityId = sanitizeForPrompt(req.personalityId);
      }
      const refusal = await this.ask(approval, frame.deadline, signal);
      if (refusal) return refusal;
    }

    return { ok: true, request: { ...req, workingDir: primary.path, args: newArgs } };
  }

  /** Real + folded paths of every root; cached for the connection, rebuilt if a root is missing. */
  private rootInfo(): Array<{ root: NodeRoot; realRoot: string; folded: string }> {
    if (this.roots) return this.roots;
    const out: Array<{ root: NodeRoot; realRoot: string; folded: string }> = [];
    let complete = true;
    for (const root of this.policy.roots) {
      const realRoot = realPathOfLongestExistingAncestor(root.path);
      if (realRoot === null) complete = false;
      else out.push({ root, realRoot, folded: foldForDeny(realRoot) });
    }
    if (complete) this.roots = out;
    return out;
  }

  private checkPath(
    raw: string,
    primary: string,
    write: boolean,
    mustExist: boolean,
  ): { ok: true; abs: string } | { ok: false; refusal: Admission } {
    const expanded =
      raw === '~' ? this.home : raw.startsWith('~/') ? resolve(this.home, raw.slice(2)) : raw;
    const abs = normalize(resolve(primary, expanded));
    if (!this.policy.roots.some((r) => insideRoot(abs, r.path))) {
      return { ok: false, refusal: unreachable(`'${raw}' is outside the roots this node exposes`) };
    }
    const real = realPathOfLongestExistingAncestor(abs);
    if (real === null) return { ok: false, refusal: unreachable(`'${raw}' could not be resolved`) };
    // Judge on the real path: the most specific root whose real path contains it.
    // Containment (an allow) is exact; WHICH root governs (a deny) is judged on folded keys so a
    // case/NFC variant of a `:ro` sub-root still selects that root.
    const foldedReal = foldForDeny(real);
    let exact = false;
    let best: { root: NodeRoot; len: number } | undefined;
    for (const { root, realRoot, folded } of this.rootInfo()) {
      if (insideRoot(real, realRoot)) exact = true;
      if (!insideRoot(foldedReal, folded)) continue;
      if (!best || folded.length > best.len) best = { root, len: folded.length };
    }
    if (!exact || !best)
      return {
        ok: false,
        refusal: unreachable(`'${raw}' resolves outside the roots this node exposes`),
      };
    if (write && best.root.readOnly) {
      return { ok: false, refusal: unreachable(`'${raw}' is in a read-only root`) };
    }
    if (mustExist && !isExistingDirectory(abs)) {
      return { ok: false, refusal: failed(`cwd '${raw}' does not exist on this node`) };
    }
    return { ok: true, abs };
  }

  /**
   * NodeGuard is the serialiser for approval prompts: one at a time, FIFO (`approvalTail`), so a
   * prompt implementation needs no queue of its own. At most `MAX_PENDING_APPROVALS` calls wait;
   * the next is refused. `signal` (the call's cancel/timeout/disconnect) dequeues a waiting call
   * and is forwarded, merged with the prompt timeout, to an open prompt. A call whose deadline
   * passed while it waited is refused before anything is drawn.
   */
  private async ask(
    req: ApprovalRequest,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<Admission | null> {
    if (this.approve === null) return failed('refused: no TTY to approve on');
    if (this.pendingApprovals >= MAX_PENDING_APPROVALS) {
      return notAvailable('too many approvals are waiting on this node');
    }
    this.pendingApprovals += 1;
    const approve = this.approve;
    const prev = this.approvalTail;
    let release!: () => void;
    const mine = new Promise<void>((res) => {
      release = res;
    });
    // The next waiter needs the previous holder AND this call to be done, so an aborted waiter
    // cannot let its successor overlap the prompt that is still open.
    this.approvalTail = Promise.all([prev, mine]).then(() => undefined);
    const aborted = () => failed('refused: the call was cancelled before the owner answered');
    let onAbort: (() => void) | undefined;
    const abortWait = new Promise<'aborted'>((res) => {
      if (!signal) return;
      if (signal.aborted) return res('aborted');
      onAbort = () => res('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const prompt = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const turn = await Promise.race([prev.then(() => 'turn' as const), abortWait]);
      if (turn === 'aborted' || signal?.aborted) return aborted();
      if (deadline < this.now())
        return notAvailable('call deadline passed while waiting for approval');
      const timeout = new Promise<'timeout'>((res) => {
        timer = setTimeout(() => res('timeout'), NODE_APPROVAL_TIMEOUT_MS);
      });
      const answer = await Promise.race([approve(req, prompt.signal), timeout, abortWait]);
      if (answer === 'timeout') return failed('refused: approval timed out on the laptop');
      if (answer === 'aborted') return aborted();
      return answer ? null : failed('refused by the laptop owner');
    } catch {
      // A throwing prompt must refuse, never admit.
      return failed('refused: approval prompt failed on the laptop');
    } finally {
      this.pendingApprovals -= 1;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      prompt.abort();
      release();
    }
  }
}

function previewOf(name: NodeBaseTool, args: Record<string, unknown>): string {
  if (name === 'write_file') return boundedPreview(String(args.content ?? ''));
  return `--- old_text\n${boundedPreview(String(args.old_text ?? ''))}\n+++ new_text\n${boundedPreview(String(args.new_text ?? ''))}`;
}

function summarize(name: NodeBaseTool, args: Record<string, unknown>): string {
  if (name === 'write_file') return `${Buffer.byteLength(String(args.content ?? ''))} bytes`;
  const oldText = String(args.old_text ?? '');
  const newText = String(args.new_text ?? '');
  return `replace ${oldText.length} chars with ${newText.length} chars: '${firstLine(oldText)}'`;
}
