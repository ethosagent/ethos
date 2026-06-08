import { Button, Card, Form, Input, Modal, Popover, Select, Space, Tag, Typography } from 'antd';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { TableBlock } from '../chat/TableBlock';

interface EmitRule {
  on: 'rowClick';
  param: string;
  column: string;
  default: string;
}

interface PanelData {
  id: string;
  queryType: 'static' | 'prompt' | 'sql' | 'header';
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
  dependsOn: string[] | null;
  emitConfig: EmitRule[] | null;
}

interface Props {
  panel: PanelData;
  allPanels?: Array<{ id: string; title: string | null }>;
  onDelete: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onUpdatePanel?: (vars: {
    title?: string;
    cronSchedule?: string | null;
    dependsOn?: string[] | null;
    emitConfig?: EmitRule[] | null;
  }) => void;
  onEmit?: (param: string, value: string) => void;
}

const CRON_PRESETS = [
  { label: 'Every 1 min', value: '* * * * *' },
  { label: 'Every 5 min', value: '*/5 * * * *' },
  { label: 'Every 15 min', value: '*/15 * * * *' },
  { label: 'Every 30 min', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 4 hours', value: '0 */4 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 9am', value: '0 9 * * *' },
  { label: 'Weekdays at 9am', value: '0 9 * * 1-5' },
];

function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [min, hour, , , dow] = p;
  if (min === '*' && hour === '*') return 'every min';
  const mMatch = min.match(/^\*\/(\d+)$/);
  if (mMatch && hour === '*') return `every ${mMatch[1]}m`;
  const hMatch = hour.match(/^\*\/(\d+)$/);
  if (hMatch && min === '0') return `every ${hMatch[1]}h`;
  if (min === '0' && /^\d+$/.test(hour)) {
    const suffix = dow === '1-5' ? ' weekdays' : '';
    return `daily ${hour}:00${suffix}`;
  }
  return expr;
}

export function DashboardPanelShell({
  panel,
  allPanels,
  onDelete,
  onRefresh,
  refreshing,
  onUpdatePanel,
  onEmit,
}: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (panel.queryType === 'header') {
    return (
      <div
        style={{
          padding: '8px 4px',
          borderBottom: '1px solid #f0f0f0',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          {panel.title ?? 'Section'}
        </Typography.Title>
        {panel.content && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {panel.content}
          </Typography.Text>
        )}
      </div>
    );
  }

  return (
    <>
      <Card
        size="small"
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
        styles={{
          body: {
            flex: 1,
            overflow: 'hidden',
            minHeight: 0,
            padding: panel.blockType === 'html' ? 0 : 12,
            position: 'relative',
          },
        }}
        title={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              userSelect: 'none',
            }}
          >
            <Space>
              <Typography.Text strong style={{ fontSize: 12 }}>
                {panel.title || 'Panel'}
              </Typography.Text>
              {panel.queryType !== 'static' && (
                <Tag color="blue" style={{ fontSize: 10 }}>
                  {panel.queryType}
                </Tag>
              )}
              {panel.cronSchedule && (
                <Tag color="cyan" style={{ fontSize: 10 }} title={panel.cronSchedule}>
                  ⏱ {describeCron(panel.cronSchedule)}
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
            {onUpdatePanel && (
              <Button size="small" type="text" title="Edit" onClick={() => setEditing(true)}>
                ✏
              </Button>
            )}
            {onRefresh && (
              <Button size="small" type="text" onClick={onRefresh} loading={refreshing}>
                ↻
              </Button>
            )}
            <Button size="small" type="text" onClick={() => setFullscreen(true)} title="Fullscreen">
              ⛶
            </Button>
            <Button size="small" type="text" danger onClick={() => setConfirmDelete(true)}>
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
          emitConfig={panel.emitConfig}
          onEmit={onEmit}
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

      {onUpdatePanel && (
        <EditPanelModal
          open={editing}
          panel={panel}
          allPanels={allPanels}
          onCancel={() => setEditing(false)}
          onSave={(vals) => {
            onUpdatePanel(vals);
            setEditing(false);
          }}
        />
      )}

      <Modal
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onOk={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        okText="Delete"
        okButtonProps={{ danger: true }}
        cancelText="Cancel"
        title="Delete panel?"
        width={380}
      >
        <p style={{ margin: 0 }}>
          Remove <strong>{panel.title || 'this panel'}</strong> from the dashboard? This cannot be
          undone.
        </p>
      </Modal>
    </>
  );
}

function EditPanelModal({
  open,
  panel,
  allPanels,
  onCancel,
  onSave,
}: {
  open: boolean;
  panel: PanelData;
  allPanels?: Array<{ id: string; title: string | null }>;
  onCancel: () => void;
  onSave: (vals: {
    title?: string;
    cronSchedule?: string | null;
    dependsOn?: string[] | null;
    emitConfig?: EmitRule[] | null;
  }) => void;
}) {
  const [form] = Form.useForm();
  const [cronPreview, setCronPreview] = useState(
    panel.cronSchedule ? describeCron(panel.cronSchedule) : '',
  );

  const handleCronChange = (val: string) => {
    setCronPreview(val ? describeCron(val) : '');
    form.setFieldValue('cronSchedule', val);
  };

  return (
    <Modal
      open={open}
      title="Edit panel"
      onCancel={onCancel}
      onOk={() => {
        const vals = form.getFieldsValue() as {
          title: string;
          cronSchedule: string;
          dependsOn: string[] | undefined;
          emitConfig:
            | Array<{ on: string; param: string; column: string; default: string }>
            | undefined;
        };
        const emitRules = (vals.emitConfig ?? [])
          .filter((r) => r.param && r.column)
          .map((r) => ({ ...r, on: 'rowClick' as const }));
        onSave({
          title: vals.title || undefined,
          cronSchedule: vals.cronSchedule || null,
          dependsOn: vals.dependsOn?.length ? vals.dependsOn : null,
          emitConfig: emitRules.length > 0 ? emitRules : null,
        });
      }}
      okText="Save"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          title: panel.title ?? '',
          cronSchedule: panel.cronSchedule ?? '',
          dependsOn: panel.dependsOn ?? [],
          emitConfig: panel.emitConfig ?? [],
        }}
        style={{ marginTop: 16 }}
      >
        <Form.Item label="Title" name="title">
          <Input placeholder="Panel title" />
        </Form.Item>

        {panel.queryType !== 'header' && (
          <Form.Item
            label="Auto-refresh (cron)"
            name="cronSchedule"
            extra={
              cronPreview ? (
                <span style={{ color: '#52c41a' }}>↻ {cronPreview}</span>
              ) : (
                <span style={{ color: '#888' }}>Leave empty to disable auto-refresh</span>
              )
            }
          >
            <Input
              placeholder="*/15 * * * *"
              onChange={(e) => handleCronChange(e.target.value)}
              addonAfter={
                <Select
                  size="small"
                  placeholder="Presets"
                  style={{ width: 140 }}
                  variant="borderless"
                  onChange={(val: string) => handleCronChange(val)}
                  options={[
                    ...CRON_PRESETS.map((p) => ({ label: p.label, value: p.value })),
                    { label: 'Clear', value: '' },
                  ]}
                />
              }
            />
          </Form.Item>
        )}

        {panel.queryType !== 'header' && allPanels && allPanels.length > 0 && (
          <Form.Item label="Depends on" name="dependsOn">
            <Select
              mode="multiple"
              size="small"
              placeholder="Select panels this depends on"
              options={allPanels
                .filter((p) => p.id !== panel.id)
                .map((p) => ({ label: p.title ?? p.id.slice(0, 8), value: p.id }))}
            />
          </Form.Item>
        )}

        {panel.queryType !== 'header' && (
          <Form.Item label="Emit on row click">
            <Form.List name="emitConfig">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space
                      key={field.key}
                      style={{ display: 'flex', marginBottom: 4 }}
                      align="start"
                    >
                      <Form.Item name={[field.name, 'param']} noStyle>
                        <Input size="small" placeholder="Param key" style={{ width: 100 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'column']} noStyle>
                        <Input size="small" placeholder="Column" style={{ width: 100 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'default']} noStyle>
                        <Input size="small" placeholder="Default" style={{ width: 100 }} />
                      </Form.Item>
                      <Button size="small" danger onClick={() => remove(field.name)}>
                        x
                      </Button>
                    </Space>
                  ))}
                  <Button
                    size="small"
                    type="dashed"
                    onClick={() => add({ on: 'rowClick', param: '', column: '', default: '' })}
                  >
                    + Emit rule
                  </Button>
                </>
              )}
            </Form.List>
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

function PanelContent({
  blockType,
  content,
  metadata,
  fill,
  fullscreen,
  emitConfig,
  onEmit,
}: {
  blockType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  fill?: boolean;
  fullscreen?: boolean;
  emitConfig?: EmitRule[] | null;
  onEmit?: (param: string, value: string) => void;
}) {
  if (!content) {
    return <div style={{ color: '#888', padding: 20, textAlign: 'center' }}>Loading...</div>;
  }

  switch (blockType) {
    case 'html': {
      const ethosRuntime = `<script>
window.ethos = {
  select: function(param, value) {
    window.parent.postMessage({ type: 'ethos:select', param: param, value: value }, '*');
  }
};
</script>`;
      const injectedContent = content.includes('window.ethos') ? content : ethosRuntime + content;
      return (
        <iframe
          srcDoc={injectedContent}
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
    }
    case 'image':
      return <img src={content} alt={String(metadata?.alt ?? '')} style={{ maxWidth: '100%' }} />;
    case 'table': {
      const handleRowClick =
        emitConfig && onEmit
          ? (row: Record<string, unknown>) => {
              for (const rule of emitConfig) {
                if (rule.on === 'rowClick') {
                  onEmit(rule.param, String(row[rule.column] ?? ''));
                }
              }
            }
          : undefined;
      return fill || fullscreen ? (
        <div style={{ height: '100%', overflow: 'auto' }}>
          <TableBlock data={content} onRowClick={handleRowClick} />
        </div>
      ) : (
        <TableBlock data={content} onRowClick={handleRowClick} />
      );
    }
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
          <span style={valueStyle}>
            <code style={{ fontSize: 11 }}>{panel.cronSchedule}</code>
            <span style={{ marginLeft: 6, color: '#52c41a', fontSize: 11 }}>
              ({describeCron(panel.cronSchedule)})
            </span>
          </span>
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
