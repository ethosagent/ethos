import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MemoryViewProps {
  content: string;
}

const markdownComponents: Components = {
  h1({ children }) {
    return (
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: '0 0 12px',
        }}
      >
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: '16px 0 8px',
        }}
      >
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: '12px 0 6px',
        }}
      >
        {children}
      </h3>
    );
  },
  p({ children }) {
    return (
      <p
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          fontWeight: 400,
          color: 'var(--text-primary)',
          lineHeight: 1.6,
          margin: '0 0 8px',
        }}
      >
        {children}
      </p>
    );
  },
  ul({ children }) {
    return <ul style={{ paddingLeft: 12, margin: '4px 0' }}>{children}</ul>;
  },
  ol({ children }) {
    return <ol style={{ paddingLeft: 12, margin: '4px 0' }}>{children}</ol>;
  },
  li({ children }) {
    return (
      <li
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          color: 'var(--text-primary)',
          lineHeight: 1.6,
        }}
      >
        {children}
      </li>
    );
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const isBlock = match != null;

    if (isBlock) {
      return (
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            background: 'var(--bg-overlay)',
            borderRadius: 8,
            padding: 12,
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
          borderRadius: 4,
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

export function MemoryView({ content }: MemoryViewProps) {
  return (
    <div style={{ lineHeight: 1.6 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
