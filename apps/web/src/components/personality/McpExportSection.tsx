import type {
  McpExportCallWire,
  McpExportClientWire,
  McpExportDenialWire,
  McpExportDesktopEntryWire,
  McpExportScopeViewWire,
  McpExportViewWire,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Popconfirm, Spin, Typography } from 'antd';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionOpenPath } from '../../lib/workspaceRoutes';
import { rpc } from '../../rpc';

// MCP export section — plan/phases/trust-before-reach.md Part 3, M-T9, built to
// the approved mockup. Read-only over the declaration: `mcp_export` lives in the
// personality's config.yaml and the schema is frozen, so this names the file and
// the keys instead of offering an edit with nowhere to write.
//
// Containers are raw primitives with token colour — "Cards earn existence"
// reserves the Card primitive for three other surfaces. The personality accent
// (the workspace scope's `--accent` and Antd `colorPrimary`) appears on exactly
// two things: the Add client action and the one-time key reveal.

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

export function McpExportSection({ personalityId }: { personalityId: string }) {
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
        <McpExportBody view={query.data} />
      ) : null}
    </div>
  );
}

function McpExportBody({ view }: { view: McpExportViewWire }) {
  if (!view.exported) {
    return (
      <div style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={headingStyle}>{view.personalityId}</h3>
          <Pill tone="off" icon="✗">
            Not exported
          </Pill>
        </div>
        <div style={noticeStyle}>
          <span aria-hidden="true" style={{ ...dimStyle, fontFamily: MONO }}>
            →
          </span>
          <span>
            No external app can consult this personality. Set <Mono>mcp_export.enabled: true</Mono>{' '}
            in <Mono>{view.configPath}</Mono> to export it. Export is off unless that value is
            literally <Mono>true</Mono>.
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <ScopePanel view={view} />
      <ClientsBlock view={view} />
      <CallsBlock personalityId={view.personalityId} calls={view.calls} />
      <DenialsBlock denials={view.denials} />
    </>
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

function ScopePanel({ view }: { view: McpExportViewWire }) {
  const scope = view.scope;
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={headingStyle}>{view.personalityId}</h3>
        <Pill tone="on" icon="✓">
          Exported over MCP
        </Pill>
      </div>

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
          This declaration is read-only here. Edit <Mono>mcp_export.*</Mono> in{' '}
          <Mono>{view.configPath}</Mono> — the keys are {listKeys(view.declarationKeys)}.
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
