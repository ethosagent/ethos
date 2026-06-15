import { Chip } from '../ui/Chip';
import { StatusDot } from '../ui/StatusDot';
import type { Panel } from './types';

interface DashboardPanelProps {
  panel: Panel;
  onRefresh: (panelId: string) => void;
  onDelete: (panelId: string) => void;
  onDragHandlePointerDown: (e: React.PointerEvent) => void;
  onDragHandlePointerMove: (e: React.PointerEvent) => void;
  onDragHandlePointerUp: (e: React.PointerEvent) => void;
}

interface ParsedTable {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

function parseTable(content: string): ParsedTable | null {
  try {
    const data: unknown = JSON.parse(content);
    if (Array.isArray(data)) {
      if (data.length === 0) return { columns: [], rows: [] };
      const first = data[0];
      if (first === null || typeof first !== 'object') return null;
      const columns = Object.keys(first as Record<string, unknown>);
      return { columns, rows: data as Array<Record<string, unknown>> };
    }
    if (data !== null && typeof data === 'object') {
      const obj = data as { columns?: unknown; rows?: unknown };
      if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) {
        return {
          columns: obj.columns.map((c) => String(c)),
          rows: obj.rows as Array<Record<string, unknown>>,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function PanelBody({ panel }: { panel: Panel }) {
  if (panel.blockType === 'html') {
    return (
      <iframe
        srcDoc={panel.content}
        sandbox="allow-scripts"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        title={panel.title ?? 'Panel'}
      />
    );
  }
  if (panel.blockType === 'image') {
    return <img src={panel.content} alt={panel.title ?? ''} style={{ maxWidth: '100%' }} />;
  }
  if (panel.blockType === 'pdf') {
    return (
      <embed src={panel.content} type="application/pdf" style={{ width: '100%', height: '100%' }} />
    );
  }
  if (panel.blockType === 'text') {
    return (
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          margin: 0,
          padding: 8,
          fontSize: 12,
          color: 'var(--text-primary)',
        }}
      >
        {panel.content}
      </pre>
    );
  }

  // table
  const parsed = parseTable(panel.content);
  if (!parsed || parsed.columns.length === 0) {
    return (
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          margin: 0,
          padding: 8,
          fontSize: 12,
          color: 'var(--text-primary)',
        }}
      >
        {panel.content}
      </pre>
    );
  }
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
      <thead>
        <tr>
          {parsed.columns.map((col) => (
            <th
              key={col}
              style={{
                padding: '4px 8px',
                textAlign: 'left',
                color: 'var(--text-secondary)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {parsed.rows.map((row, rowIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: row data has no stable id
          <tr key={rowIndex}>
            {parsed.columns.map((col) => (
              <td
                key={col}
                style={{
                  padding: '4px 8px',
                  color: 'var(--text-primary)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                {String(row[col])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DashboardPanel({
  panel,
  onRefresh,
  onDelete,
  onDragHandlePointerDown,
  onDragHandlePointerMove,
  onDragHandlePointerUp,
}: DashboardPanelProps) {
  const rootStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    overflow: 'hidden',
  };

  if (panel.queryType === 'header') {
    return (
      <div style={{ ...rootStyle, padding: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
          {panel.title ?? panel.content}
        </div>
        {panel.title && panel.content ? (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
            {panel.content}
          </div>
        ) : null}
      </div>
    );
  }

  const toolbarButtonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    color: 'var(--text-secondary)',
    padding: 0,
    lineHeight: 1,
  };

  return (
    <div style={rootStyle}>
      <div
        style={{
          height: 28,
          padding: '0 8px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          title="Drag"
          onPointerDown={onDragHandlePointerDown}
          onPointerMove={onDragHandlePointerMove}
          onPointerUp={onDragHandlePointerUp}
          style={{
            cursor: 'grab',
            color: 'var(--text-tertiary)',
            fontSize: 13,
            userSelect: 'none',
            touchAction: 'none',
          }}
        >
          ⠿
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 12,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {panel.title ?? 'Untitled'}
        </span>
        {panel.lastError ? (
          <span title={panel.lastError}>
            <Chip label="error" variant="error" />
          </span>
        ) : null}
        <StatusDot color={panel.lastError ? 'var(--error)' : 'var(--success)'} />
        <button type="button" onClick={() => onRefresh(panel.id)} style={toolbarButtonStyle}>
          ↻
        </button>
        <button
          type="button"
          onClick={() => onDelete(panel.id)}
          style={toolbarButtonStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--error)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <PanelBody panel={panel} />
      </div>
    </div>
  );
}
