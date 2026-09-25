// The readline surface for the terminal approval gate
// (`wireTerminalApprovalGate`, apps/ethos/src/terminal-approval.ts). Renders
// each pending call — tool, flagged reason, redacted args — and reads one line:
// `y` / `yes` allows, anything else (including an empty Enter) denies.
//
// One prompt at a time. Requests that arrive while one is open wait in FIFO
// order and are shown as each answer lands, so two parallel tool calls never
// share the input line. A request settled elsewhere (timeout, Ctrl-C cancel)
// closes its prompt, or leaves the queue, with a line saying it was denied.

import type { BridgeApprovalRequest, BridgeApprovalSource } from '@ethosagent/agent-bridge';

/** The slice of `readline.Interface` the prompt drives. */
export interface ApprovalPromptReadline {
  once(event: 'line', listener: (line: string) => void): unknown;
  off(event: 'line', listener: (line: string) => void): unknown;
  setPrompt(prompt: string): void;
  prompt(): void;
}

export interface CliApprovalPromptDeps {
  source: BridgeApprovalSource;
  rl: ApprovalPromptReadline;
  write: (text: string) => void;
  /** Before the first prompt of a run is drawn: stop the spinner, claim input. */
  onOpen: () => void;
  /** After the last queued prompt closes: hand input back. */
  onClose: () => void;
  /**
   * Draw the `Allow? [y/N]` question as the readline prompt (default). Pass
   * `false` when readline's output is not where the user looks — `ethos chat`
   * with stdout piped: the question is then written through `write` (stderr
   * there) with everything else, and readline only reads the answer.
   */
  questionOnReadline?: boolean;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** The block drawn above the `Allow? [y/N]` line. */
export function formatCliApprovalRequest(req: BridgeApprovalRequest): string {
  return (
    `\n${yellow(`approval needed · ${req.toolName}`)}\n` +
    `${dim('  reason')}  ${req.reason}\n` +
    `${dim('  args  ')}  ${req.argsPreview}\n`
  );
}

/** `y` / `yes` (any case) allows; every other line denies. */
export function isApprovalYes(line: string): boolean {
  return /^y(es)?$/i.test(line.trim());
}

export function attachCliApprovalPrompt(deps: CliApprovalPromptDeps): {
  /** True while a prompt owns the input line. */
  isOpen: () => boolean;
  dispose: () => void;
} {
  const queue: BridgeApprovalRequest[] = [];
  let current: { request: BridgeApprovalRequest; onLine: (line: string) => void } | null = null;
  let open = false;

  const advance = (): void => {
    if (current) return;
    const next = queue.shift();
    if (!next) {
      if (open) {
        open = false;
        deps.onClose();
      }
      return;
    }
    if (!open) {
      open = true;
      deps.onOpen();
    }
    const onLine = (line: string): void => {
      if (current?.request.approvalId !== next.approvalId) return;
      current = null;
      const allow = isApprovalYes(line);
      deps.write(dim(allow ? `  allowed ${next.toolName}\n` : `  denied ${next.toolName}\n`));
      deps.source.decide(next.approvalId, allow ? 'allow' : 'deny');
      advance();
    };
    current = { request: next, onLine };
    deps.write(formatCliApprovalRequest(next));
    const question = `${yellow('Allow?')} [y/N] `;
    deps.rl.once('line', onLine);
    if (deps.questionOnReadline === false) {
      deps.write(question);
    } else {
      deps.rl.setPrompt(question);
      deps.rl.prompt();
    }
  };

  const offRequest = deps.source.onRequest((request) => {
    queue.push(request);
    advance();
  });
  const offSettled = deps.source.onSettled((approvalId, decision) => {
    // Our own answer already cleared `current` before deciding.
    if (current?.request.approvalId === approvalId) {
      deps.rl.off('line', current.onLine);
      deps.write(
        dim(
          `\n  ${decision === 'allow' ? 'allowed' : 'denied'} ${current.request.toolName} (no answer typed — timed out or cancelled)\n`,
        ),
      );
      current = null;
      advance();
      return;
    }
    const index = queue.findIndex((r) => r.approvalId === approvalId);
    if (index >= 0) queue.splice(index, 1);
  });

  return {
    isOpen: () => open,
    dispose: () => {
      offRequest();
      offSettled();
      if (current) deps.rl.off('line', current.onLine);
    },
  };
}
