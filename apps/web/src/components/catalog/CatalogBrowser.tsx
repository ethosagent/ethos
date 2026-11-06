import { filterCatalog } from '@ethosagent/catalog/filter';
import type { CatalogKind } from '@ethosagent/types';
import type { CatalogListEntry } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, Segmented, Spin, Tag, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { invalidateAfterInstall, useCatalog } from '../../features/catalog/api/queries';
import { groupByCategory } from '../../features/mcp/catalog';
import { useMcpOAuthPopup } from '../../features/mcp/useMcpOAuthPopup';
import { rpc } from '../../rpc';
import { McpSectionLabel } from '../mcp/McpSectionLabel';
import { FeedbackRow } from '../ui/FeedbackRow';
import { capabilityLine } from './capability-line';

// Dense rows, not a card grid (DESIGN.md "Cards earn existence"). Generalises
// the retired `McpCatalogSection`: one click per entry either registers the
// server globally or starts OAuth. A catalog click NEVER attaches a
// personality (plan/phases/unified-catalog.md §2, decision 1) — no
// `personalityId` reaches `rpc.mcp.start` / `rpc.mcp.addServer`; pinned by
// __tests__/CatalogBrowser.test.ts "oauth click ... no personalityId".

interface Props {
  /** Inline: the kind listed. Modal: the opening page's kind (segmented default). */
  kind?: CatalogKind;
  /** Passed back to `onManual` only. Never sent to an install RPC (decision 1). */
  personalityContext?: string;
  mode: 'inline' | 'modal';
  /** Modal mode only. */
  open?: boolean;
  onClose?: () => void;
  /** Modal mode: the page's manual path (AddMcpModal / npm spec / CreateSkillModal). */
  onManual?: (kind: CatalogKind, personalityContext?: string) => void;
}

type Feedback =
  | { state: 'installing' }
  | { state: 'registered'; hint?: string }
  | { state: 'failed'; reason: string }
  // Clipboard unavailable (non-secure context): the command stays on screen.
  | { state: 'manual'; command: string };

const KIND_LABEL: Record<CatalogKind, string> = { mcp: 'MCP', plugin: 'Plugins', skill: 'Skills' };
const MANUAL_LABEL: Record<CatalogKind, string> = {
  mcp: 'Custom server…',
  plugin: 'Install by npm spec…',
  skill: 'Write a skill…',
};
const EMPTY_TEXT: Record<CatalogKind, string> = {
  mcp: 'Nothing left to add from the catalog.',
  plugin: 'No reviewed plugins yet. Install by npm spec below.',
  skill: 'No reviewed skills yet. Write one below.',
};

export function CatalogBrowser({
  kind,
  personalityContext,
  mode,
  open = false,
  onClose,
  onManual,
}: Props) {
  if (mode === 'inline') return <CatalogRows kind={kind} variant="inline" />;
  return (
    <Modal
      title="Add from catalog"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
    >
      <ModalBody kind={kind} personalityContext={personalityContext} onManual={onManual} />
    </Modal>
  );
}

function ModalBody({
  kind,
  personalityContext,
  onManual,
}: Pick<Props, 'kind' | 'personalityContext' | 'onManual'>) {
  const pageKind = kind ?? 'mcp';
  const [active, setActive] = useState<CatalogKind>(pageKind);
  const [query, setQuery] = useState('');
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Input
          allowClear
          placeholder="Search the catalog"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1 }}
        />
        <Segmented<CatalogKind>
          value={active}
          onChange={setActive}
          options={(['mcp', 'plugin', 'skill'] as const).map((k) => ({
            value: k,
            label: KIND_LABEL[k],
          }))}
        />
      </div>
      <CatalogRows kind={active} variant="modal" query={query} />
      {onManual ? (
        <div style={{ marginTop: 16 }}>
          <Button
            type="link"
            style={{ padding: 0 }}
            onClick={() => onManual(pageKind, personalityContext)}
          >
            {MANUAL_LABEL[pageKind]}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CatalogRows({
  kind,
  variant,
  query = '',
}: {
  kind?: CatalogKind;
  variant: 'inline' | 'modal';
  query?: string;
}) {
  const qc = useQueryClient();
  const catalog = useCatalog(kind);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const oauthId = useRef<string | null>(null);

  const setFb = (id: string, fb: Feedback) => setFeedback((prev) => ({ ...prev, [id]: fb }));

  const addServer = useMutation({
    mutationFn: (v: { id: string; name: string; url: string }) =>
      rpc.mcp.addServer({
        name: v.name,
        url: v.url,
        transport: 'streamable-http',
        authType: 'none',
      }),
    onSuccess: (result, v) => {
      if (!result.ok) {
        setFb(v.id, {
          state: 'failed',
          reason: ('detail' in result ? result.detail : result.code) ?? 'Failed to add server',
        });
        return;
      }
      setFb(v.id, { state: 'registered' });
      invalidateAfterInstall(qc);
    },
    onError: (err, v) =>
      setFb(v.id, { state: 'failed', reason: err instanceof Error ? err.message : String(err) }),
  });

  // Plugin / skill install. Input is exactly `{ id }`: no `personalityId`
  // (D9: an install never grants); pinned by CatalogBrowser.test.ts.
  const install = useMutation({
    mutationFn: (id: string) => rpc.catalog.install({ id }),
    onSuccess: (result, id) => {
      setFb(id, { state: 'registered', hint: result.grantHint });
      invalidateAfterInstall(qc);
    },
    onError: (err, id) =>
      setFb(id, { state: 'failed', reason: err instanceof Error ? err.message : String(err) }),
  });

  // No `personalityId` — a catalog click only writes the global registry.
  const oauth = useMcpOAuthPopup({
    onSuccess: () => {
      if (oauthId.current) setFb(oauthId.current, { state: 'registered' });
      oauthId.current = null;
      invalidateAfterInstall(qc);
    },
    onError: (message) => {
      if (oauthId.current) setFb(oauthId.current, { state: 'failed', reason: message });
      oauthId.current = null;
    },
  });

  const act = (entry: CatalogListEntry) => {
    const a = entry.action;
    if (a.type === 'oauth') {
      setFb(entry.id, { state: 'installing' });
      oauthId.current = entry.id;
      // `name` is the entry id, so the server's own `installed` check matches
      // on the next load (omitting it derives a name from the URL instead).
      void oauth.start({ url: a.url, name: a.name });
    } else if (a.type === 'add') {
      setFb(entry.id, { state: 'installing' });
      addServer.mutate({ id: entry.id, name: a.name, url: a.url });
    } else if (a.type === 'install') {
      setFb(entry.id, { state: 'installing' });
      install.mutate(entry.id);
    } else if (a.type === 'cli') {
      const manual: Feedback = { state: 'manual', command: a.command };
      if (!navigator.clipboard) {
        setFb(entry.id, manual);
        return;
      }
      void navigator.clipboard.writeText(a.command).then(
        () => setFb(entry.id, { state: 'registered' }),
        () => setFb(entry.id, manual),
      );
    }
  };

  const groups = useMemo(() => {
    const all = catalog.data?.entries ?? [];
    const matching = new Set(filterCatalog(all, { query }).map((e) => e.id));
    // Installed entries are omitted, not disabled (D10) — except one we just
    // acted on, which stays so its feedback row persists.
    return groupByCategory(
      all.filter((e) => matching.has(e.id) && (!e.installed || feedback[e.id])),
    );
  }, [catalog.data, query, feedback]);

  if (catalog.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 80 }}>
        <Spin />
      </div>
    );
  }
  if (catalog.isError) {
    return variant === 'inline' ? null : (
      <Typography.Text type="danger">Could not load the catalog.</Typography.Text>
    );
  }

  const count = groups.reduce((n, g) => n + g.items.length, 0);
  if (count === 0) {
    if (variant === 'inline') return null;
    if (query.trim()) return <Typography.Text type="secondary">No matches.</Typography.Text>;
    return <Typography.Text type="secondary">{EMPTY_TEXT[kind ?? 'mcp']}</Typography.Text>;
  }

  return (
    <>
      {variant === 'inline' ? <McpSectionLabel>Catalog ({count})</McpSectionLabel> : null}
      {groups.map((group) => (
        <div key={group.category} style={{ marginBottom: 12 }}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 500, display: 'block', margin: '8px 0 4px' }}
          >
            {group.category}
          </Typography.Text>
          {group.items.map((entry) => (
            <CatalogRow
              key={entry.id}
              entry={entry}
              feedback={feedback[entry.id]}
              onAct={() => act(entry)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function actionLabel(action: CatalogListEntry['action']): string {
  switch (action.type) {
    case 'oauth':
      return 'Connect';
    case 'add':
      return 'Add';
    case 'install':
      return 'Install';
    case 'cli':
      return 'Copy command';
  }
}

function CatalogRow({
  entry,
  feedback,
  onAct,
}: {
  entry: CatalogListEntry;
  feedback: Feedback | undefined;
  onAct: () => void;
}) {
  const installing = feedback?.state === 'installing';
  const done = feedback?.state === 'registered';
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)', padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: '16px' }}>
            <strong>{entry.name}</strong>
            <TierTag tier={entry.tier} />
            <Typography.Text
              type="secondary"
              ellipsis
              title={entry.description}
              style={{ fontSize: 12, minWidth: 0 }}
            >
              {entry.description}
            </Typography.Text>
          </div>
          <div
            style={{
              fontFamily: "'Geist Mono', monospace",
              fontSize: 12,
              lineHeight: '16px',
              color: 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {capabilityLine(entry)}
          </div>
        </div>
        {done ? null : (
          <Button size="small" loading={installing} onClick={onAct}>
            {actionLabel(entry.action)}
          </Button>
        )}
      </div>
      {feedback ? <CatalogFeedback entry={entry} feedback={feedback} /> : null}
    </div>
  );
}

function TierTag({ tier }: { tier: CatalogListEntry['tier'] }) {
  const community = tier === 'community';
  return (
    <Tag
      bordered={false}
      style={{
        marginInlineEnd: 0,
        lineHeight: '16px',
        ...(community ? { color: 'var(--warning)' } : {}),
      }}
    >
      {community ? '⚠ community' : tier}
    </Tag>
  );
}

// Persistent row, never a toast (DESIGN.md "Feedback rows outside chat", D12).
// The shared FeedbackRow supplies glyph + word (running / ok / failed).
function CatalogFeedback({ entry, feedback }: { entry: CatalogListEntry; feedback: Feedback }) {
  if (feedback.state === 'manual') {
    return (
      <>
        <FeedbackRow
          status="failed"
          subject={entry.name}
          result="Clipboard unavailable. Copy the command below."
        />
        <code
          style={{
            display: 'block',
            fontFamily: "'Geist Mono', monospace",
            fontSize: 12,
            userSelect: 'all',
            overflowWrap: 'anywhere',
            paddingBottom: 4,
          }}
        >
          {feedback.command}
        </code>
      </>
    );
  }
  if (feedback.state === 'installing') {
    return <FeedbackRow status="running" subject={entry.name} result="installing" />;
  }
  if (feedback.state === 'failed') {
    return <FeedbackRow status="failed" subject={entry.name} result={feedback.reason} />;
  }
  return (
    <FeedbackRow
      status="ok"
      subject={entry.name}
      result={
        entry.action.type === 'cli'
          ? 'copied'
          : feedback.hint
            ? `installed. ${feedback.hint}`
            : 'registered'
      }
    />
  );
}
