import type { ApprovalRequest, ApprovalScope } from '@ethosagent/web-contracts';
import { Button } from 'antd';
import { useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { getClientId } from '../../lib/clientId';
import { rpc } from '../../rpc';

// Approval modal anchored to the personality bar — DESIGN.md "approval
// modal anchored to the personality bar (top-right of chat), slide-down
// 180ms". NOT a centered Antd Modal: the agent itself is asking
// permission, so the panel slides DOWN from where the agent's face lives.
//
// The modal owns three pieces of UX:
//   1. Render the pending tool: name + reason + args preview.
//   2. Scope choice (stacked radios — DESIGN.md anti-slop rule, no card
//      grids inside the modal either): once / exact-args / any-args. An
//      always-ask tool (`request.alwaysAsk`) cannot be allowlisted — the
//      server refuses both "forever" scopes for it — so it gets once /
//      lease-1h instead: the widest answer it can have is one hour. A
//      hardline command (`request.hardline`) gets once only: the server
//      stores nothing for one whatever scope is sent (`ApprovalsService.approve`).
//   3. Allow / Deny buttons that fire the matching RPC. The reducer
//      drops the request from `pendingApprovals` on the SSE
//      `approval.resolved` event so the modal closes naturally; we
//      don't manage open/closed state locally.

type ScopeOption = { value: ApprovalScope; label: string; hint: string };

const ONCE_OPTION: ScopeOption = {
  value: 'once',
  label: 'Just this command',
  hint: 'Allow this single invocation, ask again next time.',
};

const SCOPE_OPTIONS: ScopeOption[] = [
  ONCE_OPTION,
  {
    value: 'exact-args',
    label: 'This exact command',
    hint: 'Allow this tool with these exact arguments forever.',
  },
  {
    value: 'any-args',
    label: 'Any args for this tool',
    hint: 'Allow every future invocation of this tool, regardless of args.',
  },
];

const ALWAYS_ASK_SCOPE_OPTIONS: ScopeOption[] = [
  ONCE_OPTION,
  {
    value: 'lease-1h',
    label: 'Allow for 1 hour',
    hint: 'Allow this tool in this chat, with any arguments, for the next hour. Revoke it in Settings → Security & access.',
  },
];

function scopeOptions(request: ApprovalRequest): ScopeOption[] {
  if (request.hardline) return [ONCE_OPTION];
  return request.alwaysAsk ? ALWAYS_ASK_SCOPE_OPTIONS : SCOPE_OPTIONS;
}

export interface ApprovalModalProps {
  request: ApprovalRequest;
}

export function ApprovalModal({ request }: ApprovalModalProps) {
  const [scope, setScope] = useState<ApprovalScope>('once');
  const [submitting, setSubmitting] = useState<'allow' | 'deny' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // W5 — an alertdialog owns focus: first control on open (the `once` radio),
  // back to wherever the user was when `approval.resolved` unmounts it.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const handle = async (decision: 'allow' | 'deny') => {
    setSubmitting(decision);
    setSubmitError(null);
    try {
      if (decision === 'allow') {
        await rpc.tools.approve({
          approvalId: request.approvalId,
          clientId: getClientId(),
          scope,
        });
      } else {
        await rpc.tools.deny({
          approvalId: request.approvalId,
          clientId: getClientId(),
        });
      }
      // The SSE `approval.resolved` event drops this request from
      // `pendingApprovals`, which causes the parent to unmount the
      // modal. We don't need to manage local close state.
    } catch (err) {
      setSubmitting(null);
      const message = err instanceof Error ? err.message : String(err);
      setSubmitError(message);
    }
  };

  return (
    <div
      ref={panelRef}
      className="approval-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
      tabIndex={-1}
    >
      <header className="approval-modal-header">
        <span className="approval-modal-icon" aria-hidden="true">
          ?
        </span>
        <h2 id="approval-modal-title" className="approval-modal-title">
          <code>{request.toolName}</code> wants to run
        </h2>
      </header>

      {request.reason ? <p className="approval-modal-reason">{request.reason}</p> : null}

      <pre className="approval-modal-args">{formatArgs(request.args)}</pre>

      <fieldset className="approval-modal-scope">
        <legend className="approval-modal-scope-legend">Scope</legend>
        {scopeOptions(request).map((opt) => (
          <label key={opt.value} className="approval-modal-scope-option">
            <input
              type="radio"
              name="scope"
              value={opt.value}
              checked={scope === opt.value}
              onChange={() => setScope(opt.value)}
              disabled={submitting !== null}
            />
            <span className="approval-modal-scope-label">{opt.label}</span>
            <span className="approval-modal-scope-hint">{opt.hint}</span>
          </label>
        ))}
      </fieldset>

      {submitError ? (
        <div className="approval-modal-error" role="alert">
          {submitError}
        </div>
      ) : null}

      <div className="approval-modal-actions">
        <Button
          type="primary"
          loading={submitting === 'allow'}
          disabled={submitting !== null}
          onClick={() => void handle('allow')}
        >
          Allow
        </Button>
        <Button
          loading={submitting === 'deny'}
          disabled={submitting !== null}
          onClick={() => void handle('deny')}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
