import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ClarifyRow } from './ClarifyRow';
import { StreamCursor } from './StreamCursor';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolApprovalRow } from './ToolApprovalRow';
import { ToolCallRow } from './ToolCallRow';
import type { ApprovalState, ClarifyState, ToolCallState, UsageState } from './types';

interface AssistantMessageProps {
  content: string;
  thinking?: string;
  toolCalls?: ToolCallState[];
  usage?: UsageState;
  streaming?: boolean;
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  pendingApproval?: ApprovalState;
  pendingClarify?: ClarifyState;
  onClarifyRespond?: (id: string, answer: string) => void;
  onRetry?: () => void;
  error?: string;
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  }
  return n.toLocaleString();
}

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const isBlock = match != null;

    if (isBlock) {
      return (
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            margin: '8px 0',
            overflowX: 'auto',
          }}
        >
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }

    return (
      <code
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          background: 'var(--bg-overlay)',
          borderRadius: 'var(--radius-sm)',
          padding: '2px 5px',
        }}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
};

function ThinkingDots() {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 3,
        alignItems: 'center',
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            backgroundColor: 'var(--text-tertiary)',
            display: 'inline-block',
            animation: `thinking-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes thinking-dot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </span>
  );
}

export function AssistantMessage({
  content,
  thinking,
  toolCalls,
  usage,
  streaming,
  onApprove,
  onDeny,
  pendingApproval,
  pendingClarify,
  onClarifyRespond,
  onRetry,
  error,
}: AssistantMessageProps) {
  return (
    <div
      style={{
        margin: '6px 0',
        fontFamily: 'var(--font-display)',
        fontSize: 14,
        color: 'var(--text-primary)',
        lineHeight: 1.5,
      }}
    >
      {thinking && <ThinkingBlock thinking={thinking} />}

      {toolCalls?.map((tc, i) => (
        <ToolCallRow
          // biome-ignore lint/suspicious/noArrayIndexKey: ToolCallState has no stable id
          key={`${tc.name}-${i}`}
          toolCallId={`${tc.name}-${i}`}
          name={tc.name}
          args={tc.args}
          status={tc.status}
          durationMs={tc.durationMs}
          result={tc.result}
          progressMessage={tc.progressMessage}
        />
      ))}

      {pendingApproval && onApprove && onDeny && (
        <ToolApprovalRow
          approvalId={pendingApproval.approvalId}
          toolName={pendingApproval.toolName}
          args={pendingApproval.args}
          reason={pendingApproval.reason}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      )}

      {pendingClarify && onClarifyRespond && (
        <ClarifyRow
          requestId={pendingClarify.requestId}
          question={pendingClarify.question}
          options={pendingClarify.options}
          defaultAnswer={pendingClarify.defaultAnswer}
          onRespond={onClarifyRespond}
        />
      )}

      {content && (
        <div className="assistant-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
          {streaming && <StreamCursor />}
        </div>
      )}

      {!content && streaming && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 0',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-display)',
            fontSize: 13,
          }}
        >
          <span>Thinking</span>
          <ThinkingDots />
        </div>
      )}

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span style={{ color: 'var(--error)', fontSize: 13, fontFamily: 'var(--font-display)' }}>
            {error}
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {usage && !streaming && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            marginTop: 6,
          }}
        >
          {formatTokens(usage.inputTokens + usage.outputTokens)} tokens · ~$
          {usage.estimatedCostUsd.toFixed(3)}
        </div>
      )}
    </div>
  );
}
