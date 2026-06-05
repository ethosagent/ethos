import { useState } from 'react';

interface MessageBubbleProps {
  content: string;
  timestamp: string;
  isSteer?: boolean;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageBubble({ content, timestamp, isSteer }: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip on a presentational message bubble
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        margin: '6px 0',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {isSteer && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            marginBottom: 2,
          }}
        >
          ↗ Steering
        </div>
      )}
      {hovered && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            marginBottom: 2,
          }}
        >
          {formatTime(timestamp)}
        </div>
      )}
      <div
        style={{
          maxWidth: '75%',
          background: 'var(--bg-overlay)',
          borderRadius: '12px 12px 4px 12px',
          padding: '10px 14px',
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          color: 'var(--text-primary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content}
      </div>
    </div>
  );
}
