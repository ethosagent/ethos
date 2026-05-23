import { useCallback } from 'react';

interface ToolApprovalRowProps {
  approvalId: string;
  toolName: string;
  args: unknown;
  reason: string | null;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export function ToolApprovalRow({
  approvalId,
  toolName,
  args,
  reason,
  onApprove,
  onDeny,
}: ToolApprovalRowProps) {
  const handleApprove = useCallback(() => onApprove(approvalId), [onApprove, approvalId]);
  const handleDeny = useCallback(() => onDeny(approvalId), [onDeny, approvalId]);

  let argsPreview: string;
  try {
    argsPreview = JSON.stringify(args, null, 2);
  } catch {
    argsPreview = String(args);
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--warning)',
        padding: '12px 0',
        margin: '8px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14, color: 'var(--warning)' }}>⚠</span>
        <span
          style={{
            fontSize: 14,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-display)',
          }}
        >
          Approval required
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}
        >
          {toolName}
        </span>
      </div>
      {reason && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginBottom: 8,
          }}
        >
          {reason}
        </div>
      )}
      <pre
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          background: 'var(--bg-overlay)',
          borderRadius: 'var(--radius-md)',
          padding: '8px 12px',
          margin: '0 0 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text-secondary)',
          maxHeight: '4.8em',
          overflow: 'hidden',
          lineHeight: '1.2em',
        }}
      >
        {argsPreview}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={handleApprove}
          style={{
            height: 28,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--success)',
            color: 'var(--bg-base)',
            border: 'none',
            padding: '0 14px',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'var(--font-display)',
            cursor: 'pointer',
          }}
        >
          Approve
        </button>
        <button
          type="button"
          onClick={handleDeny}
          style={{
            height: 28,
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--error)',
            border: 'none',
            padding: '0 14px',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'var(--font-display)',
            cursor: 'pointer',
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
