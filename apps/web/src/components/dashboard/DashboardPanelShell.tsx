import { Button, Card, Modal, Popover, Space, Tag, Typography } from 'antd';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { TableBlock } from '../chat/TableBlock';

interface PanelData {
  id: string;
  queryType: 'static' | 'prompt' | 'sql';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  title: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  prompt: string | null;
  sqlQuery: string | null;
  pluginId: string | null;
  dataSourceId: string | null;
  cronSchedule: string | null;
  htmlTemplate: string | null;
}

interface Props {
  panel: PanelData;
  onDelete: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function DashboardPanelShell({ panel, onDelete, onRefresh, refreshing }: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <>
      <Card
        size="small"
        style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
        styles={{
          body: {
            flex: 1,
            overflow: 'hidden',
            minHeight: 0,
            padding: panel.blockType === 'html' ? 0 : 12,
          },
        }}
        title={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
            }}
          >
            <Space>
              <span
                className="drag-handle"
                style={{ cursor: 'grab', marginRight: 8, userSelect: 'none' }}
              >
                &#x2807;
              </span>
              <Typography.Text strong style={{ fontSize: 12 }}>
                {panel.title || 'Panel'}
              </Typography.Text>
              {panel.queryType !== 'static' && (
                <Tag color="blue" style={{ fontSize: 10 }}>
                  {panel.queryType}
                </Tag>
              )}
              {panel.lastError && (
                <Tag color="red" style={{ fontSize: 10 }}>
                  Error
                </Tag>
              )}
            </Space>
            {panel.lastRunAt && (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 10, fontWeight: 'normal', marginRight: 8 }}
              >
                {new Date(panel.lastRunAt).toLocaleTimeString()}
              </Typography.Text>
            )}
          </div>
        }
        extra={
          <Space size="small">
            <Popover
              trigger="click"
              title="Panel details"
              placement="bottomRight"
              overlayStyle={{ width: 360 }}
              content={<PanelInfoContent panel={panel} />}
            >
              <Button size="small" type="text" title="Info">
                ℹ
              </Button>
            </Popover>
            {onRefresh && (
              <Button size="small" type="text" onClick={onRefresh} loading={refreshing}>
                ↻
              </Button>
            )}
            <Button size="small" type="text" onClick={() => setFullscreen(true)} title="Fullscreen">
              ⛶
            </Button>
            <Button size="small" type="text" danger onClick={onDelete}>
              ×
            </Button>
          </Space>
        }
      >
        {panel.lastError && (
          <div style={{ color: '#ff4d4f', fontSize: 12, marginBottom: 8 }}>{panel.lastError}</div>
        )}
        <PanelContent
          blockType={panel.blockType}
          content={panel.content}
          metadata={panel.metadata}
          fill
        />
      </Card>
      <Modal
        open={fullscreen}
        onCancel={() => setFullscreen(false)}
        footer={null}
        title={panel.title || 'Panel'}
        width="100vw"
        style={{ top: 0, paddingBottom: 0, maxWidth: '100vw' }}
        styles={{ body: { height: 'calc(100vh - 56px)', padding: 0, overflow: 'hidden' } }}
      >
        <PanelContent
          blockType={panel.blockType}
          content={panel.content}
          metadata={panel.metadata}
          fullscreen
        />
      </Modal>
    </>
  );
}

function PanelContent({
  blockType,
  content,
  metadata,
  fill,
  fullscreen,
}: {
  blockType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  fill?: boolean;
  fullscreen?: boolean;
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
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          title={String(metadata?.title ?? 'Panel')}
        />
      );
    case 'image':
      return <img src={content} alt={String(metadata?.alt ?? '')} style={{ maxWidth: '100%' }} />;
    case 'table':
      return fill || fullscreen ? (
        <div style={{ height: '100%', overflow: 'auto' }}>
          <TableBlock data={content} />
        </div>
      ) : (
        <TableBlock data={content} />
      );
    case 'text':
      return (
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 13,
            ...(fill || fullscreen ? { height: '100%', overflow: 'auto' } : {}),
          }}
        >
          {content}
        </pre>
      );
    case 'pdf':
      return (
        <embed
          src={content}
          type="application/pdf"
          style={{ width: '100%', height: fill || fullscreen ? '100%' : 400 }}
        />
      );
    default:
      return <pre>{content}</pre>;
  }
}

function PanelInfoContent({ panel }: { panel: PanelData }) {
  const rowStyle: CSSProperties = {
    display: 'flex',
    gap: 8,
    marginBottom: 6,
    fontSize: 12,
    alignItems: 'flex-start',
  };
  const labelStyle: CSSProperties = {
    color: '#888',
    minWidth: 90,
    flexShrink: 0,
  };
  const valueStyle: CSSProperties = {
    flex: 1,
    wordBreak: 'break-word',
  };
  const preStyle: CSSProperties = {
    margin: 0,
    maxHeight: 80,
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    fontSize: 11,
    background: '#f5f5f5',
    padding: '4px 6px',
    borderRadius: 4,
  };

  return (
    <div style={{ minWidth: 280, maxHeight: 320, overflowY: 'auto' }}>
      <div style={rowStyle}>
        <span style={labelStyle}>Query type</span>
        <span style={valueStyle}>
          <Tag
            color={
              panel.queryType === 'prompt'
                ? 'blue'
                : panel.queryType === 'sql'
                  ? 'purple'
                  : 'default'
            }
            style={{ margin: 0 }}
          >
            {panel.queryType}
          </Tag>
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Block type</span>
        <span style={valueStyle}>{panel.blockType}</span>
      </div>
      {panel.prompt && (
        <div style={rowStyle}>
          <span style={labelStyle}>Prompt</span>
          <pre style={{ ...preStyle, ...valueStyle }}>{panel.prompt}</pre>
        </div>
      )}
      {panel.sqlQuery && (
        <div style={rowStyle}>
          <span style={labelStyle}>SQL query</span>
          <pre style={{ ...preStyle, ...valueStyle }}>{panel.sqlQuery}</pre>
        </div>
      )}
      {panel.pluginId && (
        <div style={rowStyle}>
          <span style={labelStyle}>Plugin</span>
          <span style={valueStyle}>{panel.pluginId}</span>
        </div>
      )}
      {panel.dataSourceId && (
        <div style={rowStyle}>
          <span style={labelStyle}>Data source</span>
          <span style={valueStyle}>{panel.dataSourceId}</span>
        </div>
      )}
      {panel.cronSchedule && (
        <div style={rowStyle}>
          <span style={labelStyle}>Cron</span>
          <span style={valueStyle}>{panel.cronSchedule}</span>
        </div>
      )}
      {panel.htmlTemplate && (
        <div style={rowStyle}>
          <span style={labelStyle}>Template</span>
          <span style={valueStyle}>
            <Tag color="green" style={{ margin: 0 }}>
              html
            </Tag>
          </span>
        </div>
      )}
      <div style={{ ...rowStyle, marginBottom: 0 }}>
        <span style={labelStyle}>Panel ID</span>
        <span style={valueStyle}>
          <Typography.Text copyable style={{ fontSize: 11 }}>
            {panel.id}
          </Typography.Text>
        </span>
      </div>
    </div>
  );
}
