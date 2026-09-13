import type {
  McpExportCallWire,
  McpExportClientWire,
  McpExportDeclarationViewWire,
  McpExportDenialWire,
  McpExportDesktopEntryWire,
  McpExportScopeViewWire,
  McpExportViewWire,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Input, Popconfirm, Radio, Segmented, Spin, Typography } from 'antd';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionOpenPath } from '../../lib/workspaceRoutes';
import { rpc } from '../../rpc';

// MCP export section — plan/phases/trust-before-reach.md Part 3, M-T9, built to
// the approved mockups. `mcp_export` lives in the personality's config.yaml
// (the field already exists on the frozen schema); the form writes it through
// `personalities.update`, which shallow-merges the patch onto the stored block.
//
// Containers are raw primitives with token colour — "Cards earn existence"
// reserves the Card primitive for three other surfaces. The personality accent
// (the workspace scope's `--accent` and Antd `colorPrimary`) appears on the
// primary action of each state — Set up export, Turn on export / Save changes,
// Add client — and on the one-time key reveal.

const MONO = "'Geist Mono', ui-monospace, monospace";

const panelStyle: CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const subLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

const headingStyle: CSSProperties = { fontSize: 16, fontWeight: 500, lineHeight: 1.4, margin: 0 };
const dimStyle: CSSProperties = { color: 'var(--text-tertiary)' };
const monoStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};

const noticeStyle: CSSProperties = {
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--text-secondary)',
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `09:12` today, `Yest 17:20`, otherwise `4 Sep 09:12`. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return clock(d);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yest ${clock(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(d)}`;
}

/** `4 Sep`. */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * The Desktop entry with the minted secret in the key slot. The server built
 * the entry with a placeholder (`claudeDesktopExportEntry`,
 * apps/ethos/src/commands/mcp-export.ts); the secret only ever exists here, in
 * the operator's browser, from the `apiKeys.create` response.
 */
export function desktopEntryWithSecret(entry: McpExportDesktopEntryWire, secret: string): string {
  if (!entry.secretPlaceholder) return entry.json;
  return entry.json.split(JSON.stringify(entry.secretPlaceholder)).join(JSON.stringify(secret));
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

type PillTone = 'on' | 'off' | 'deny';

/** State as a pill with an icon AND a word — never colour alone. */
function Pill({ tone, icon, children }: { tone: PillTone; icon: string; children: ReactNode }) {
  const color =
    tone === 'on' ? 'var(--success)' : tone === 'deny' ? 'var(--error)' : 'var(--text-tertiary)';
  return (
    <span
      data-pill={tone}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 'var(--radius-sm)',
        padding: '3px 8px',
        fontSize: 12,
        fontWeight: 500,
        border: `1px solid ${tone === 'off' ? 'var(--border-strong)' : color}`,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ fontFamily: MONO }}>
        {icon}
      </span>
      {children}
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={monoStyle}>{children}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13 }}>{children}</dd>
    </>
  );
}

interface Column {
  label: string;
  mono?: boolean;
  action?: boolean;
}

/** A plain table in a bordered container — repeated rows of one shape are a table, not cards. */
function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: Column[];
  rows: Array<{ key: string; cells: ReactNode[] }>;
  empty: string;
}) {
  const cell = (col: Column | undefined, last: boolean): CSSProperties => ({
    padding: col?.action ? '8px 0' : '8px 12px 8px 0',
    borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
    verticalAlign: 'baseline',
    textAlign: col?.action ? 'right' : 'left',
    ...(col?.mono ? monoStyle : {}),
  });
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are static per table
                key={i}
                style={{
                  ...subLabelStyle,
                  textAlign: 'left',
                  padding: '0 12px 8px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                  whiteSpace: 'nowrap',
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ ...cell(undefined, true), ...dimStyle }}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, r) => (
              <tr key={row.key}>
                {row.cells.map((content, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  <td key={c} style={cell(columns[c], r === rows.length - 1)}>
                    {content}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function McpExportSection({
  personalityId,
  toolset,
}: {
  personalityId: string;
  /** The personality's own toolset (`personalities.get`); null when unrestricted. */
  toolset: string[] | null;
}) {
  const query = useQuery({
    queryKey: ['personalities', 'mcpExport', personalityId],
    queryFn: () => rpc.personalities.mcpExport({ id: personalityId }),
  });

  return (
    <div style={{ marginBottom: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        MCP export
      </Typography.Title>
      {query.isLoading ? (
        <Spin size="small" />
      ) : query.error ? (
        <span style={{ fontSize: 13, color: 'var(--error)' }}>
          ✗ MCP export status unavailable — {errorMessage(query.error)}
        </span>
      ) : query.data ? (
        <McpExportBody view={query.data} toolset={toolset} />
      ) : null}
    </div>
  );
}

type McpExportPatch = NonNullable<Parameters<typeof rpc.personalities.update>[0]['mcp_export']>;

function McpExportBody({ view, toolset }: { view: McpExportViewWire; toolset: string[] | null }) {
  const qc = useQueryClient();
  const personalityId = view.personalityId;
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ enabled: boolean; at: string } | null>(null);

  const saveMut = useMutation({
    mutationFn: (patch: McpExportPatch) =>
      rpc.personalities.update({ id: personalityId, mcp_export: patch }),
    onSuccess: async (_res, patch) => {
      // Close the form only once the view has refetched, so the section never
      // flashes the state it just left.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['personalities', 'mcpExport', personalityId] }),
        qc.invalidateQueries({ queryKey: ['personalities', 'get', personalityId] }),
        qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', personalityId] }),
      ]);
      setSaved({ enabled: patch.enabled === true, at: clock(new Date()) });
      setEditing(false);
    },
  });

  const openForm = () => {
    saveMut.reset();
    setEditing(true);
  };
  const closeForm = () => {
    saveMut.reset();
    setEditing(false);
  };

  const feedback = saveMut.isError ? (
    <SaveFailedRow
      message={errorMessage(saveMut.error)}
      onRetry={() => {
        if (saveMut.variables) saveMut.mutate(saveMut.variables);
      }}
    />
  ) : saved ? (
    <SavedRow enabled={saved.enabled} at={saved.at} />
  ) : null;

  const form = editing ? (
    <ExportForm
      view={view}
      toolset={toolset}
      saving={saveMut.isPending}
      feedback={feedback}
      onSubmit={(patch) => saveMut.mutate(patch)}
      onCancel={closeForm}
    />
  ) : null;

  if (!view.exported) {
    return (
      form ?? (
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={headingStyle}>{personalityId}</h3>
            <Pill tone="off" icon="✗">
              Not exported
            </Pill>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', maxWidth: '65ch' }}>
            No external app can consult {personalityId}. Exporting lets an MCP client — Claude
            Desktop, Cursor — ask it a question and get a full, safeguarded turn back.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button type="primary" onClick={openForm}>
              Set up export
            </Button>
            <span style={mechStyle}>Nothing changes until you save.</span>
          </div>
          {feedback}
        </div>
      )
    );
  }

  return (
    <>
      {form ?? (
        <ScopePanel
          view={view}
          feedback={feedback}
          turningOff={saveMut.isPending}
          onEdit={openForm}
          onTurnOff={() => saveMut.mutate({ enabled: false })}
        />
      )}
      <ClientsBlock view={view} />
      <CallsBlock personalityId={personalityId} calls={view.calls} />
      <DenialsBlock denials={view.denials} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Save feedback — the `.activity-row` of `FeedbackRow`
// (components/ui/FeedbackRow.tsx, DESIGN.md "Feedback rows outside chat"),
// carrying the approved words "saved" / "not saved" where `RowState` would say
// the generic "ok" / "failed". Persistent, never a toast.
// ---------------------------------------------------------------------------

const mechStyle: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };

function SavedRow({ enabled, at }: { enabled: boolean; at: string }) {
  return (
    <div className="activity-row activity-row-ok" role="status" data-testid="mcp-export-save-row">
      <span className="activity-row-state">
        <span aria-hidden="true">✓</span> saved
      </span>
      <span className="activity-row-subject">mcp_export.enabled: {String(enabled)}</span>
      <span className="activity-row-result">applies on each app's next call</span>
      <span className="activity-row-meta">{at}</span>
    </div>
  );
}

function SaveFailedRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <div
        className="activity-row activity-row-failed"
        role="status"
        data-testid="mcp-export-save-row"
      >
        <span className="activity-row-state">
          <span aria-hidden="true">✗</span> not saved
        </span>
        <span className="activity-row-result" style={{ whiteSpace: 'normal' }}>
          {message}
        </span>
      </div>
      <Button size="small" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup / edit form
// ---------------------------------------------------------------------------

type ToolsMode = 'none' | 'selected' | 'all';

export interface ExportDraft {
  tools: ToolsMode;
  selected: string[];
  memory: 'none' | 'scoped' | 'full';
  sessions: boolean;
  auth: 'localhost' | 'bearer';
}

/**
 * Where the form starts: the stored declaration when there is one (including a
 * turned-off one, whose settings Turn off keeps), else the defaults
 * `resolveMcpExportScope` (packages/wiring/src/mcp-export.ts) gives an absent
 * key — no tools, no memory, no conversations, localhost.
 */
export function draftFromDeclaration(
  declaration: McpExportDeclarationViewWire | null,
): ExportDraft {
  const tools = declaration?.expose_tools;
  return {
    tools: tools === 'all' ? 'all' : Array.isArray(tools) ? 'selected' : 'none',
    selected: Array.isArray(tools) ? [...tools] : [],
    memory: declaration?.expose_memory ?? 'none',
    sessions: declaration?.expose_sessions ?? false,
    auth: declaration?.auth ?? 'localhost',
  };
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The plain-language line under the form, derived from the current choices. */
export function exportSummary(draft: ExportDraft, id: string): string {
  const who = draft.auth === 'bearer' ? 'An app with a key' : 'An app started on this machine';
  const can = [
    draft.tools === 'all'
      ? `use all of ${id}'s tools`
      : draft.tools === 'selected'
        ? `use ${draft.selected.length} of ${id}'s tools`
        : 'use none of its tools',
  ];
  const cannot: string[] = [];
  if (draft.memory === 'full') {
    can.push('read and write its memory');
  } else if (draft.memory === 'scoped') {
    can.push('read its memory');
    cannot.push('write memory');
  } else {
    cannot.push('use memory');
  }
  if (draft.sessions) can.push('list and reopen its own past conversations');
  else cannot.push('open past conversations');
  const tail = cannot.length > 0 ? `, and cannot ${cannot.join(' or ')}` : '';
  return `${who} will see one tool, ask. Its turn can ${joinAnd(can)}${tail}.`;
}

function Field({
  name,
  label,
  hint,
  first = false,
  children,
}: {
  name: string;
  label: string;
  hint?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-field={name}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px 16px',
        paddingTop: first ? 0 : 16,
        borderTop: first ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ flex: '0 0 190px', fontSize: 13, fontWeight: 500 }}>
        {label}
        {hint ? (
          <span
            style={{ ...dimStyle, display: 'block', fontWeight: 400, fontSize: 12, marginTop: 2 }}
          >
            {hint}
          </span>
        ) : null}
      </div>
      <div
        style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {children}
      </div>
    </div>
  );
}

function Choice({ title, desc }: { title: string; desc: ReactNode }) {
  return (
    <span style={{ fontSize: 13 }}>
      {title}
      <span style={{ ...dimStyle, display: 'block', fontSize: 12 }}>{desc}</span>
    </span>
  );
}

function ExportForm({
  view,
  toolset,
  saving,
  feedback,
  onSubmit,
  onCancel,
}: {
  view: McpExportViewWire;
  toolset: string[] | null;
  saving: boolean;
  feedback: ReactNode;
  onSubmit: (patch: McpExportPatch) => void;
  onCancel: () => void;
}) {
  const id = view.personalityId;
  const [draft, setDraft] = useState(() => draftFromDeclaration(view.declaration));
  // The picker lists the personality's OWN toolset, never the machine's. A name
  // the stored declaration already carries but the toolset lacks stays listed
  // (and ticked) so a save never silently rewrites what the file says;
  // `resolveMcpExportScope` drops it at serve time either way.
  const [options] = useState(() => {
    const own = toolset ?? [];
    return [...own, ...draft.selected.filter((tool) => !own.includes(tool))];
  });
  const [filter, setFilter] = useState('');
  const set = (next: Partial<ExportDraft>) => setDraft((d) => ({ ...d, ...next }));

  const own = new Set(toolset ?? []);
  const needle = filter.trim().toLowerCase();
  const visible = options.filter((tool) => tool.toLowerCase().includes(needle));
  const needsTool = draft.tools === 'selected' && draft.selected.length === 0;
  const monoInline: CSSProperties = { fontFamily: MONO };

  const submit = () =>
    onSubmit({
      enabled: true,
      expose_tools:
        draft.tools === 'selected'
          ? options.filter((tool) => draft.selected.includes(tool))
          : draft.tools,
      expose_memory: draft.memory,
      expose_sessions: draft.sessions,
      auth: draft.auth,
    });

  return (
    <div style={{ ...panelStyle, gap: 16 }}>
      <h3 style={headingStyle}>Export {id} over MCP</h3>

      <Field
        name="tools"
        first
        label="Tools the caller's turn may use"
        hint={
          <>
            The app never sees these as tools — it sees one tool,{' '}
            <span style={monoInline}>ask</span>.
          </>
        }
      >
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Segmented<ToolsMode>
            value={draft.tools}
            onChange={(tools) => set({ tools })}
            options={[
              { label: 'None — conversation only', value: 'none' },
              { label: 'Selected', value: 'selected' },
              { label: `All of ${id}'s tools`, value: 'all' },
            ]}
          />
        </div>
        {draft.tools === 'selected' ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Input
                type="search"
                size="small"
                aria-label="Filter tools"
                placeholder={`Filter ${options.length} tools`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ maxWidth: 280 }}
              />
              <span style={{ ...mechStyle, fontVariantNumeric: 'tabular-nums' }}>
                {draft.selected.length} of {options.length} selected
              </span>
            </div>
            <fieldset
              data-testid="mcp-export-tool-grid"
              aria-label={`${id} tools`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                gap: '2px 12px',
                maxHeight: 216,
                overflowY: 'auto',
                padding: '4px 0',
                margin: 0,
                border: 0,
                minWidth: 0,
              }}
            >
              {options.length === 0 ? (
                <span style={{ ...dimStyle, fontSize: 13 }}>{id}'s toolset lists no tools.</span>
              ) : null}
              {visible.map((tool) => (
                <Checkbox
                  key={tool}
                  checked={draft.selected.includes(tool)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setDraft((d) => ({
                      ...d,
                      selected: on ? [...d.selected, tool] : d.selected.filter((t) => t !== tool),
                    }));
                  }}
                  style={{ fontFamily: MONO, fontSize: 12, minWidth: 0 }}
                >
                  {tool}
                  {own.has(tool) ? null : (
                    <span style={{ ...dimStyle, fontFamily: 'inherit', fontSize: 11 }}>
                      {' '}
                      not in toolset
                    </span>
                  )}
                </Checkbox>
              ))}
            </fieldset>
          </>
        ) : null}
        {draft.tools !== 'none' ? (
          // True of every exported turn: `createExportApprovalGate`
          // (apps/ethos/src/commands/mcp-export.ts) turns the approval danger
          // predicate into a `before_tool_call` REJECTION (M-D10). No per-tool
          // "needs approval" flag is shown: `Tool.requiresApproval` is
          // announcement-only (packages/core/src/agent-loop/stages/tool-processing.ts),
          // and the real predicate flags by name and by approvalMode in
          // packages/wiring/src/danger-predicate.ts, which the web never receives.
          <span style={mechStyle}>
            Calls that would need approval are refused in an exported turn — nobody is there to
            approve them.
          </span>
        ) : null}
      </Field>

      <Field
        name="memory"
        label="Memory"
        hint={`Only ${id}'s own memory, never another personality's.`}
      >
        <Radio.Group
          value={draft.memory}
          onChange={(e) => set({ memory: e.target.value })}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <Radio value="none">
            <Choice title="None" desc="No memory is loaded and no memory tools are offered." />
          </Radio>
          <Radio value="scoped">
            <Choice
              title="Read"
              desc={
                <>
                  The turn sees {id}'s memory; <span style={monoInline}>memory_write</span> is
                  withheld.
                </>
              }
            />
          </Radio>
          <Radio value="full">
            <Choice
              title="Read and write"
              desc={`An outside app can change what ${id} remembers.`}
            />
          </Radio>
        </Radio.Group>
        {draft.memory === 'full' ? (
          <div
            role="note"
            style={{ ...noticeStyle, borderColor: 'var(--warning)', color: 'var(--text-primary)' }}
          >
            <span aria-hidden="true" style={{ fontFamily: MONO, color: 'var(--warning)' }}>
              ⚠
            </span>
            <span>
              Any app with access can change what {id} remembers, and those changes carry into your
              own chats with it.
            </span>
          </div>
        ) : null}
      </Field>

      <Field name="sessions" label="Conversations">
        <Checkbox checked={draft.sessions} onChange={(e) => set({ sessions: e.target.checked })}>
          <Choice
            title="Let each app list and reopen its own conversations"
            desc={
              <>
                Adds <span style={monoInline}>list_conversations</span> and{' '}
                <span style={monoInline}>get_conversation</span>. An app never sees yours or another
                app's.
              </>
            }
          />
        </Checkbox>
      </Field>

      <Field name="auth" label="Who can connect">
        <Radio.Group
          value={draft.auth}
          onChange={(e) => set({ auth: e.target.value })}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <Radio value="localhost">
            <Choice
              title="Apps started on this machine, no key"
              desc={
                <>
                  stdio only. Anything that can run <span style={monoInline}>ethos</span> as you can
                  connect.
                </>
              }
            />
          </Radio>
          <Radio value="bearer">
            <Choice
              title="Apps holding a client key"
              desc="stdio or loopback HTTP. You issue and revoke keys below, per app."
            />
          </Radio>
        </Radio.Group>
      </Field>

      <div style={noticeStyle} data-testid="mcp-export-summary">
        <span aria-hidden="true" style={{ ...dimStyle, fontFamily: MONO }}>
          →
        </span>
        <span>{exportSummary(draft, id)}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button type="primary" loading={saving} disabled={needsTool} onClick={submit}>
          {view.exported ? 'Save changes' : 'Turn on export'}
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        {needsTool ? (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Tick at least one tool, or choose None — conversation only.
          </span>
        ) : null}
      </div>
      {feedback}
      {/* "No restart" is `PersonalityExportServer` re-running
          `refreshPersonalities()` and `resolveScope` before every gate
          (apps/mcp-server/src/export-server.ts). */}
      <div style={mechStyle}>
        Saves <span style={monoInline}>mcp_export.*</span> in{' '}
        <span style={monoInline}>{view.configPath}</span>. Takes effect on the app's next call — no
        restart.
      </div>
    </div>
  );
}

const MEMORY_COPY: Record<McpExportScopeViewWire['memory'], [string, string]> = {
  none: ['none', 'no prefetch, no memory tools'],
  scoped: ['scoped', "reads this personality's memory; memory_write withheld"],
  full: ['full', "reads and writes this personality's memory"],
};

function listKeys(keys: string[]): ReactNode {
  return keys.map((key, i) => (
    <span key={key}>
      {i === 0 ? '' : i === keys.length - 1 ? ' and ' : ', '}
      <Mono>{key}</Mono>
    </span>
  ));
}

function ScopePanel({
  view,
  feedback,
  turningOff,
  onEdit,
  onTurnOff,
}: {
  view: McpExportViewWire;
  feedback: ReactNode;
  turningOff: boolean;
  onEdit: () => void;
  onTurnOff: () => void;
}) {
  const scope = view.scope;
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={headingStyle}>{view.personalityId}</h3>
        <Pill tone="on" icon="✓">
          Exported over MCP
        </Pill>
        <span style={{ flex: 1 }} />
        <Button size="small" onClick={onEdit}>
          Edit settings
        </Button>
        {/* Turning off sends `{ enabled: false }` only; the registry's shallow
            merge keeps every other key, and client keys live in the api-key
            store, untouched. */}
        <Popconfirm
          title={`Turn off export for ${view.personalityId}?`}
          description={
            <span style={{ display: 'block', maxWidth: 320 }}>
              Every connected app is refused on its next call. Its client keys are kept, so turning
              export back on lets them in again. To lock one app out for good, revoke its key
              instead.
            </span>
          }
          okText="Turn off"
          cancelText="Keep it on"
          okButtonProps={{ danger: true }}
          onConfirm={onTurnOff}
        >
          <Button size="small" danger loading={turningOff}>
            Turn off export
          </Button>
        </Popconfirm>
      </div>
      {feedback}

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)',
          gap: '8px 16px',
          margin: 0,
        }}
      >
        {scope ? (
          <>
            <Row label="Caller's turn may use">
              <ToolChips scope={scope} />
            </Row>
            <Row label="Memory">
              {MEMORY_COPY[scope.memory][0]}{' '}
              <span style={dimStyle}>— {MEMORY_COPY[scope.memory][1]}</span>
            </Row>
            <Row label="Conversations">
              {scope.sessions ? (
                <>
                  exposed{' '}
                  <span style={dimStyle}>
                    — <Mono>list_conversations</Mono> and <Mono>get_conversation</Mono>, the calling
                    client's own only
                  </span>
                </>
              ) : (
                <>
                  not exposed{' '}
                  <span style={dimStyle}>
                    — <Mono>tools/list</Mono> returns one tool
                  </span>
                </>
              )}
            </Row>
            <Row label="Auth">
              {scope.auth === 'bearer' ? (
                <>
                  bearer <span style={dimStyle}>— stdio + HTTP (loopback only)</span>
                </>
              ) : (
                <>
                  localhost <span style={dimStyle}>— stdio only, no key checked</span>
                </>
              )}
            </Row>
          </>
        ) : (
          <Row label="Caller's turn may use">
            <span style={dimStyle}>
              not resolved on this server — <Mono>{view.command}</Mono> prints the tools, memory,
              conversation and auth terms when it starts
            </span>
          </Row>
        )}
        <Row label="Command">
          <Mono>{view.command}</Mono>
        </Row>
      </dl>

      <div style={noticeStyle}>
        <span aria-hidden="true" style={{ ...dimStyle, fontFamily: MONO }}>
          →
        </span>
        <span>
          Edit settings writes <Mono>mcp_export.*</Mono> in <Mono>{view.configPath}</Mono> — the
          keys are {listKeys(view.declarationKeys)}.
        </span>
      </div>
    </div>
  );
}

function ToolChips({ scope }: { scope: McpExportScopeViewWire }) {
  const chip: CSSProperties = {
    fontFamily: MONO,
    fontSize: 12,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-overlay)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 6px',
    color: 'var(--text-secondary)',
  };
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {scope.allowed.length === 0 && scope.dropped.length === 0 ? (
          <span>
            none <span style={dimStyle}>— conversation only</span>
          </span>
        ) : null}
        {scope.allowed.map((tool) => (
          <span key={tool} style={chip}>
            {tool}
          </span>
        ))}
        {scope.dropped.map((tool) => (
          <span
            key={tool}
            data-dropped="true"
            title="named by expose_tools but outside this personality's reach"
            style={{
              ...chip,
              background: 'transparent',
              borderStyle: 'dashed',
              color: 'var(--text-tertiary)',
              textDecoration: 'line-through',
            }}
          >
            {tool}
          </span>
        ))}
      </div>
      {scope.dropped.length > 0 ? (
        <div data-testid="mcp-export-dropped" style={{ ...dimStyle, marginTop: 4, fontSize: 12 }}>
          {scope.dropped.map((tool, i) => (
            <span key={tool}>
              {i > 0 ? ', ' : ''}
              <Mono>{tool}</Mono>
            </span>
          ))}{' '}
          — not in this personality's toolset, so{' '}
          {scope.dropped.length === 1 ? 'it is' : 'they are'} dropped rather than granted.
        </div>
      ) : null}
    </>
  );
}

function ClientsBlock({ view }: { view: McpExportViewWire }) {
  const qc = useQueryClient();
  const personalityId = view.personalityId;
  const bearer = view.scope?.auth === 'bearer';
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(`Claude Desktop — ${personalityId}`);
  // The one-time secret. Held in component state only, and dropped on dismiss.
  const [minted, setMinted] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['personalities', 'mcpExport', personalityId] });
    qc.invalidateQueries({ queryKey: ['apiKeys'] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      rpc.apiKeys.create({
        name: name.trim(),
        scopes: [`mcp:${personalityId}`],
        // `apiKeys.create` requires one origin. An `mcp:<id>` key is presented
        // by an MCP client, which sends none, and no web RPC accepts this scope.
        allowedOrigins: [window.location.origin],
      }),
    onSuccess: (res) => {
      setMinted(res.secret);
      setAdding(false);
      invalidate();
    },
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => rpc.apiKeys.revoke({ id }),
    onSuccess: invalidate,
  });

  const rows = view.clients.map((client: McpExportClientWire) => ({
    key: client.id,
    cells: [
      client.name,
      `${client.prefix}…`,
      formatDay(client.createdAt),
      client.lastUsed ? formatWhen(client.lastUsed) : 'never',
      <Popconfirm
        key="revoke"
        title={`Revoke ${client.name}?`}
        description="Its next call is refused. A revoked key cannot be restored."
        okText="Revoke"
        okButtonProps={{ danger: true }}
        onConfirm={() => revokeMut.mutate(client.id)}
      >
        <Button
          size="small"
          danger
          loading={revokeMut.isPending && revokeMut.variables === client.id}
        >
          Revoke
        </Button>
      </Popconfirm>,
    ],
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={headingStyle}>Clients</h3>
        <Button type="primary" disabled={!bearer || adding} onClick={() => setAdding(true)}>
          Add client
        </Button>
        {!bearer && view.scope ? (
          <span style={{ ...dimStyle, fontSize: 12 }}>
            <Mono>auth: localhost</Mono> checks no key. Set <Mono>mcp_export.auth: bearer</Mono> to
            issue client keys.
          </span>
        ) : null}
      </div>

      <div style={panelStyle}>
        <DataTable
          columns={[
            { label: 'Name' },
            { label: 'Key', mono: true },
            { label: 'Created', mono: true },
            { label: 'Last used', mono: true },
            { label: '', action: true },
          ]}
          rows={rows}
          empty={`No client keys carry mcp:${personalityId}.`}
        />
      </div>

      {revokeMut.error ? (
        <span style={{ fontSize: 13, color: 'var(--error)' }}>
          ✗ Revoke failed — {errorMessage(revokeMut.error)}
        </span>
      ) : null}

      {adding ? (
        <div style={panelStyle}>
          <div style={subLabelStyle}>New client</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Input
              aria-label="Client name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: '1 1 240px', minWidth: 0 }}
            />
            <Button
              type="primary"
              loading={createMut.isPending}
              disabled={name.trim().length === 0}
              onClick={() => createMut.mutate()}
            >
              Create key
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          <span style={{ ...dimStyle, fontSize: 12 }}>
            Mints a key scoped <Mono>mcp:{personalityId}</Mono> — it can call this export and
            nothing else.
          </span>
          {createMut.error ? (
            <span style={{ fontSize: 13, color: 'var(--error)' }}>
              ✗ Key not created — {errorMessage(createMut.error)}
            </span>
          ) : null}
        </div>
      ) : null}

      {minted ? (
        <div style={panelStyle} data-testid="mcp-export-reveal">
          <div style={subLabelStyle}>New client — shown once</div>
          <div
            style={{
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-sm)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--bg-overlay)',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--accent)' }}>
              Copy this now. Ethos stores only its hash and cannot show it again.
            </div>
            <div style={{ ...monoStyle, wordBreak: 'break-all', color: 'var(--text-primary)' }}>
              {minted}
            </div>
            <div>
              <CopyButton text={minted} label="Copy key" />
            </div>
          </div>
          {view.desktopEntry ? (
            <DesktopEntry json={desktopEntryWithSecret(view.desktopEntry, minted)} />
          ) : (
            <DesktopEntryFromCli personalityId={personalityId} bearer />
          )}
          <div>
            <Button size="small" onClick={() => setMinted(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {!bearer ? (
        <div style={panelStyle}>
          {view.desktopEntry ? (
            <DesktopEntry json={view.desktopEntry.json} />
          ) : (
            <DesktopEntryFromCli personalityId={personalityId} bearer={false} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function DesktopEntry({ json }: { json: string }) {
  return (
    <>
      <div style={subLabelStyle}>Claude Desktop entry</div>
      <pre
        style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: 12,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--text-primary)',
          overflowX: 'auto',
          margin: 0,
        }}
      >
        {json}
      </pre>
      <div>
        <CopyButton text={json} label="Copy JSON" />
      </div>
    </>
  );
}

/**
 * Stands where the Claude Desktop entry would, when the server built none. The
 * desktop app deliberately wires no entry builder (`apps/desktop/src/main/serve.ts`):
 * the entry names the program Claude Desktop launches, and inside Electron that
 * would be the Electron binary, not the Ethos CLI.
 */
function DesktopEntryFromCli({
  personalityId,
  bearer,
}: {
  personalityId: string;
  bearer: boolean;
}) {
  return (
    <>
      <div style={subLabelStyle}>Claude Desktop entry</div>
      <div style={noticeStyle} data-testid="mcp-export-desktop-cli">
        <span aria-hidden="true" style={{ ...dimStyle, fontFamily: MONO }}>
          →
        </span>
        <span>
          The Claude Desktop entry is generated by the Ethos CLI. Create it with{' '}
          <Mono>ethos mcp install claude-desktop --personality {personalityId}</Mono>.
          {bearer ? ' The CLI mints its own client key and writes it into the entry.' : null}
        </span>
      </div>
    </>
  );
}

function CallsBlock({
  personalityId,
  calls,
}: {
  personalityId: string;
  calls: McpExportCallWire[];
}) {
  const navigate = useNavigate();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={headingStyle}>Recent external calls</h3>
      <div style={panelStyle}>
        <DataTable
          columns={[
            { label: 'Time', mono: true },
            { label: 'Client' },
            { label: 'Conversation' },
            { label: 'Cost', mono: true },
            { label: '', action: true },
          ]}
          rows={calls.map((call) => ({
            key: call.sessionId,
            cells: [
              formatWhen(call.updatedAt),
              call.clientName ?? <span style={dimStyle}>{call.clientId}</span>,
              call.title ?? <span style={dimStyle}>untitled</span>,
              `$${call.costUsd.toFixed(3)}`,
              <Button
                key="open"
                size="small"
                onClick={() => navigate(sessionOpenPath(call.sessionId, personalityId))}
              >
                Open
              </Button>,
            ],
          }))}
          empty="No external calls yet."
        />
        <div style={{ ...dimStyle, fontSize: 12 }}>
          The last 20 sessions with <Mono>platform = mcp</Mono>. Transcripts live in{' '}
          <Mono>sessions.db</Mono>; the audit events record metadata only.
        </div>
      </div>
    </div>
  );
}

function DenialsBlock({ denials }: { denials: McpExportDenialWire[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={headingStyle}>Recent denials</h3>
      <div style={panelStyle}>
        <DataTable
          columns={[{ label: 'Time', mono: true }, { label: 'Client' }, { label: 'Reason' }]}
          rows={denials.map((denial, i) => ({
            key: `${denial.ts}-${i}`,
            cells: [
              formatWhen(denial.ts),
              denial.clientName ?? (
                <span style={{ ...dimStyle, fontFamily: MONO }}>
                  {denial.clientId === '-' ? 'unknown' : denial.clientId}
                </span>
              ),
              <Pill key="reason" tone="deny" icon="✗">
                {denial.reason}
              </Pill>,
            ],
          }))}
          empty="No denials recorded."
        />
      </div>
    </div>
  );
}
