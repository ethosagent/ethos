import { Button, Card, Space, Tag, Typography } from 'antd';

interface PanelData {
  id: string;
  queryType: 'static' | 'prompt' | 'sql';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  title: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
}

interface Props {
  panel: PanelData;
  onDelete: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function DashboardPanelShell({ panel, onDelete, onRefresh, refreshing }: Props) {
  return (
    <Card
      size="small"
      title={
        <Space>
          <Typography.Text strong>{panel.title || 'Panel'}</Typography.Text>
          {panel.queryType !== 'static' && <Tag color="blue">{panel.queryType}</Tag>}
          {panel.lastError && <Tag color="red">Error</Tag>}
        </Space>
      }
      extra={
        <Space size="small">
          {onRefresh && (
            <Button size="small" type="text" onClick={onRefresh} loading={refreshing}>
              ↻
            </Button>
          )}
          <Button size="small" type="text" danger onClick={onDelete}>
            ×
          </Button>
        </Space>
      }
    >
      {panel.lastError && (
        <div style={{ color: '#ff4d4f', fontSize: 12, marginBottom: 8 }}>{panel.lastError}</div>
      )}
      <PanelContent blockType={panel.blockType} content={panel.content} metadata={panel.metadata} />
      {panel.lastRunAt && (
        <div style={{ color: '#888', fontSize: 11, marginTop: 8 }}>
          Last refreshed: {new Date(panel.lastRunAt).toLocaleString()}
        </div>
      )}
    </Card>
  );
}

function PanelContent({
  blockType,
  content,
  metadata,
}: {
  blockType: string;
  content: string;
  metadata: Record<string, unknown> | null;
}) {
  if (!content) {
    return <div style={{ color: '#888', padding: 20, textAlign: 'center' }}>Loading...</div>;
  }

  switch (blockType) {
    case 'html':
      return (
        <iframe
          srcDoc={content}
          sandbox="allow-scripts"
          style={{ width: '100%', minHeight: 200, border: 'none' }}
          title={String(metadata?.title ?? 'Panel')}
        />
      );
    case 'image':
      return <img src={content} alt={String(metadata?.alt ?? '')} style={{ maxWidth: '100%' }} />;
    case 'table': {
      try {
        const rows = JSON.parse(content) as Record<string, unknown>[];
        if (rows.length === 0) return <div style={{ color: '#888' }}>No data</div>;
        const firstRow = rows[0];
        if (!firstRow) return <div style={{ color: '#888' }}>No data</div>;
        const cols = Object.keys(firstRow);
        return (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th
                      key={c}
                      style={{
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderBottom: '1px solid #333',
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((row) => {
                  const rowKey = cols.map((c) => String(row[c] ?? '')).join('|');
                  return (
                    <tr key={rowKey}>
                      {cols.map((c) => (
                        <td key={c} style={{ padding: '4px 8px', borderBottom: '1px solid #222' }}>
                          {String(row[c] ?? '')}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      } catch {
        return <pre style={{ fontSize: 12 }}>{content}</pre>;
      }
    }
    case 'text':
      return <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{content}</pre>;
    case 'pdf':
      return <embed src={content} type="application/pdf" style={{ width: '100%', height: 400 }} />;
    default:
      return <pre>{content}</pre>;
  }
}
