import {
  type ApprovalPrompt,
  type ApprovalRequest,
  PREVIEW_MAX_LINES,
  sanitizeForPrompt,
} from '@ethosagent/wiring/nodes';
import { isApprovalYes } from './cli-approval-prompt';

// The laptop's approval prompt for `ethos node connect` (plan laptop-tool-node D9/D10), split out of
// node.ts to keep that file under the source-size ratchet.

const ONE_LINE_MAX = 200;

/**
 * Folds text onto ONE line: newline -> U+23CE, tab -> U+2192, then caps at `max` characters
 * (`Infinity` = no cap). Does NOT sanitise: use it on `ApprovalRequest` fields, which NodeGuard has
 * already sanitised once (`sanitizeForPrompt`). Pinned by node-command.test.ts "renders command and
 * path on one escaped line each".
 */
export function foldLine(s: string, max = ONE_LINE_MAX): string {
  const flat = s.replace(/\n/g, '⏎').replace(/\t/g, '→');
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}... (+${chars.length - max})` : flat;
}

/** `sanitizeForPrompt`, then `foldLine`: for text that did NOT come through NodeGuard (verification M2). */
export function oneLine(s: string, max = ONE_LINE_MAX): string {
  return foldLine(sanitizeForPrompt(s), max);
}

function renderRequest(req: ApprovalRequest): string {
  const lines = ['', `[ethos node] approval needed (${req.kind})`];
  if (req.personalityId) lines.push(`  personality: ${foldLine(req.personalityId)}`);
  lines.push(`  tool:        ${foldLine(req.tool)}`);
  // The path, command and cwd are shown in full (NodeGuard refuses oversize ones): what the owner
  // approves must be everything that runs. Only summary and preview are capped.
  if (req.path) lines.push(`  path:        ${foldLine(req.path, Number.POSITIVE_INFINITY)}`);
  if (req.command) lines.push(`  command:     ${foldLine(req.command, Number.POSITIVE_INFINITY)}`);
  if (req.cwd) lines.push(`  cwd:         ${foldLine(req.cwd, Number.POSITIVE_INFINITY)}`);
  lines.push(`  summary:     ${foldLine(req.summary)}`);
  if (req.preview) {
    const preview = req.preview.split('\n');
    for (const l of preview.slice(0, PREVIEW_MAX_LINES)) lines.push(`    | ${l}`);
    if (preview.length > PREVIEW_MAX_LINES) lines.push('    | ...');
  }
  lines.push('Allow? [y/N] ');
  return lines.join('\n');
}

/**
 * The laptop's approval prompt, passed to `NodeGuard` as its `approve`. `null` when there is no
 * TTY: NodeGuard.ask then refuses every write/command that needs approval (node-guard.test.ts "no
 * TTY"). NodeGuard is the serialiser (one prompt at a time, FIFO: node-guard.test.ts), so this
 * keeps no queue; a second prompt while one is open is refused.
 *
 * Verification M1: an answer must be typed for the prompt it answers. One reader owns stdin for the
 * whole connect session and keeps it flowing, so nothing typed earlier waits in a paused stream to
 * be read as a later answer. A prompt takes only the FIRST line that arrives after it was drawn;
 * lines with no prompt open, a half-typed line from before the draw, and the rest of a pasted chunk
 * are dropped. Pinned by node-command.test.ts "createTtyApproval".
 */
export function createTtyApproval(io: {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
  isTTY: boolean;
}): ApprovalPrompt | null {
  if (!io.isTTY) return null;
  let waiter: ((line: string | null) => void) | null = null;
  let ended = false;
  let partial = '';

  io.input.on('data', (chunk: string | Buffer) => {
    const text = partial + chunk.toString();
    const nl = text.indexOf('\n');
    // Only a complete first line can answer; everything after it in this chunk is surplus.
    partial = nl === -1 ? text : '';
    if (nl === -1 || !waiter) return;
    const answer = waiter;
    waiter = null;
    answer(text.slice(0, nl));
  });
  io.input.on('end', () => {
    ended = true;
    const answer = waiter;
    waiter = null;
    answer?.(null);
  });
  io.input.resume();

  return async (req, signal) => {
    if (signal?.aborted || ended || waiter) return false;
    const line = await new Promise<string | null>((resolve) => {
      const finish = (v: string | null) => {
        signal?.removeEventListener('abort', dismiss);
        if (waiter === finish) waiter = null;
        resolve(v);
      };
      const dismiss = () => finish(null);
      signal?.addEventListener('abort', dismiss, { once: true });
      // Drop a half-typed line from before the draw, then draw, then listen.
      partial = '';
      io.output.write(renderRequest(req));
      waiter = finish;
    });
    if (line === null) {
      io.output.write('\n(no answer: refused)\n');
      return false;
    }
    return isApprovalYes(line);
  };
}
