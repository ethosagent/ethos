import { useState } from 'react';

interface ToolListPreviewProps {
  tools: Array<{ name: string; description?: string }>;
  maxVisible?: number;
}

export function ToolListPreview({ tools, maxVisible = 5 }: ToolListPreviewProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? tools : tools.slice(0, maxVisible);
  const hasMore = tools.length > maxVisible;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {visible.map((tool) => (
        <div key={tool.name} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
          >
            {tool.name}
          </span>
          {tool.description && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {tool.description}
            </span>
          )}
        </div>
      ))}
      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--info)',
            textAlign: 'left',
          }}
        >
          Show all ({tools.length})
        </button>
      )}
    </div>
  );
}
