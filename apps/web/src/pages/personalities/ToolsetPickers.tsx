import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Empty,
  Form,
  Input,
  Popover,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { TabSaveBar } from '../../components/personality/TabSaveBar';
import { ToolDetailModal } from '../../components/personality/ToolDetailModal';
import { toolAffordance } from '../../lib/execution-posture';
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categorizeGroup,
  categoryDetail,
} from '../../lib/toolset-categories';
import { rpc } from '../../rpc';

// Category-grouped, checkable-tags toolset editor. Standalone and
// state-agnostic — `ToolsetStep` (the create-wizard tab) and
// `NewAgentDialog` (the rail-`+` fast path, P5) both wrap it around their
// own selection state rather than each rendering the catalog fetch and
// category layout themselves.
export function ToolsetPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (tool: string) => void;
}) {
  const catalogQuery = useQuery({
    queryKey: ['tools', 'catalog'],
    queryFn: () => rpc.tools.catalog({}),
  });
  const TOOL_GROUPS = (catalogQuery.data?.groups ?? []).map((g) => ({
    group: g.group,
    tools: g.tools.map((t) => t.name),
  }));

  const descMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of catalogQuery.data?.groups ?? []) {
      for (const tool of g.tools) {
        if (typeof tool.description === 'string' && tool.description.length > 0) {
          map.set(tool.name, tool.description);
        }
      }
    }
    return map;
  }, [catalogQuery.data]);

  if (catalogQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (TOOL_GROUPS.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Tools will appear after your first chat session."
      >
        <Button size="small" onClick={() => void catalogQuery.refetch()}>
          Refresh
        </Button>
      </Empty>
    );
  }

  return (
    <div>
      <Typography.Paragraph type="secondary">
        Pick the tools this personality can call. Memory and cron tools are pre-selected as
        recommended defaults. You can edit this later.
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {CATEGORY_ORDER.map((cat) => {
          const groups = TOOL_GROUPS.filter((g) => categorizeGroup(g.group) === cat);
          if (groups.length === 0) return null;
          const meta = CATEGORY_META[cat];
          const detail = categoryDetail(cat);
          return (
            <section key={cat}>
              {/* Category header: title + honest boundary chip + (i) details popover.
                  Execution's chip is conditional here — the personality does not exist
                  yet, so there is no resolved posture to fetch. The live posture shows on
                  the Execution tab after creation. We never claim a definitive "Sandboxed". */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--ethos-text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  {meta.title}
                </span>
                {cat === 'execution' ? (
                  <span style={{ fontSize: 11, color: 'var(--warning)' }}>
                    ▣ Sandboxed under Docker · host without it
                  </span>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {meta.staticBoundary?.icon} {meta.staticBoundary?.label}
                  </span>
                )}
                <Popover
                  placement="right"
                  title={`${meta.title} — execution boundary`}
                  content={
                    <div style={{ maxWidth: 280, fontSize: 12 }}>
                      <p style={{ margin: '0 0 6px' }}>{detail.whatTheyTouch}</p>
                      <p style={{ margin: '0 0 6px' }}>
                        <strong>Enforced by:</strong> {detail.enforcedBy}
                      </p>
                      {detail.note ? (
                        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{detail.note}</p>
                      ) : null}
                    </div>
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={`About the ${meta.title} execution boundary`}
                    style={{ minWidth: 0, padding: '0 4px', color: 'var(--text-secondary)' }}
                  >
                    ⓘ
                  </Button>
                </Popover>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {groups.map((group) => (
                  <div key={group.group}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                      {group.group}
                      {group.group === 'Memory' || group.group === 'Cron' ? (
                        <Tag
                          color="blue"
                          bordered={false}
                          style={{ fontSize: 10, marginLeft: 6, verticalAlign: 'middle' }}
                        >
                          recommended
                        </Tag>
                      ) : null}
                    </div>
                    {group.group === 'Cron' ? (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11, display: 'block', marginBottom: 4 }}
                      >
                        Requires a running CronScheduler (serve/gateway mode).
                      </Typography.Text>
                    ) : null}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {group.tools.map((tool) => {
                        const enabled = selected.includes(tool);
                        return (
                          <Tooltip
                            key={tool}
                            title={descMap.get(tool) ?? 'No description available'}
                          >
                            <Tag.CheckableTag
                              checked={enabled}
                              onChange={() => onToggle(tool)}
                              style={{ padding: '4px 10px', fontSize: 12 }}
                            >
                              {tool}
                            </Tag.CheckableTag>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function ToolsetEditor({
  id,
  initialToolset,
  onDirtyChange,
}: {
  id: string;
  initialToolset: string[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialToolset.join('\n'));
  const [savedDraft, setSavedDraft] = useState(initialToolset.join('\n'));

  const mut = useMutation({
    mutationFn: (text: string) =>
      rpc.personalities.update({
        id,
        toolset: text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      }),
    onSuccess: (_result, text) => {
      setSavedDraft(text);
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Toolset saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        One tool per line. Blank lines ignored. Tool names follow{' '}
        <Typography.Text code>tool_name_in_snake_case</Typography.Text>.
      </Typography.Paragraph>
      <Form.Item>
        <Input.TextArea
          value={draft}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Form.Item>
      <ToolsetAffordances draft={draft} personalityId={id} />
      <TabSaveBar
        dirty={draft !== savedDraft}
        saving={mut.isPending}
        saveSucceeded={mut.isSuccess}
        onSave={() => mut.mutate(draft)}
        {...(onDirtyChange ? { onDirtyChange } : {})}
      />
    </Form>
  );
}

// Per-tool affordance legend (Phase 2a, lane E2). Exec tools route through the
// execution backend ("runs sandboxed", linking to the Execution tab); host-side
// tools stay app-confined. No per-tool docker variants — posture is a property
// of the persona, set on the Execution tab.
//
// Each row is also the click target for `ToolDetailModal` — the one place the
// UI can tell you a listed tool is not registered here.
function ToolsetAffordances({ draft, personalityId }: { draft: string; personalityId: string }) {
  const [inspecting, setInspecting] = useState<string | null>(null);
  const tools = draft
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (tools.length === 0) return null;
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
        EXECUTION
      </Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
        {tools.map((tool) => {
          const a = toolAffordance(tool);
          return (
            <button
              key={tool}
              type="button"
              className="toolset-affordance-row"
              aria-label={`Inspect ${tool}`}
              onClick={() => setInspecting(tool)}
            >
              <span style={{ fontFamily: 'Geist Mono, monospace', minWidth: 140 }}>{tool}</span>
              {a.kind === 'exec' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  runs sandboxed ↗ Execution
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  host-side (app-confined)
                </Typography.Text>
              )}
            </button>
          );
        })}
      </div>
      {inspecting === null ? null : (
        <ToolDetailModal
          toolName={inspecting}
          personalityId={personalityId}
          onClose={() => setInspecting(null)}
        />
      )}
    </div>
  );
}
