import type { A2aIdentityViewWire, A2aPeerRowWire } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Checkbox,
  Input,
  Modal,
  Popconfirm,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { rpc } from '../../rpc';

// Per-personality Peers (A2A) section — plan §7. Scoped to the selected
// personality; rendered only when the serve-wide A2A flag is ON (settings.get
// → { enabled }). When A2A is not wired the settings read returns NOT_AVAILABLE
// (503) and the whole section is hidden, matching the Settings toggle gate.
//
// Trust model: peering is manual, human-anchored, default-deny. The add flow is
// verify-first — fetch the peer's card, then require the out-of-band fingerprint
// to match before saving. New peers land disabled; the user enables explicitly.

const MONO = 'Geist Mono, monospace';

/** True when an oRPC client error carries the `NOT_AVAILABLE` code. */
function isNotAvailable(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'NOT_AVAILABLE'
  );
}

/** Reads the structured `code` off an oRPC client error, if present. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** First ~12 chars of a fingerprint with an ellipsis; full value stays copyable. */
function shortFingerprint(fp: string): string {
  return fp.length > 12 ? `${fp.slice(0, 12)}…` : fp;
}

/** Relative "last seen" from an ms-epoch, or "never" when absent. */
function formatLastSeen(epochMs?: number): string {
  if (epochMs == null) return 'never';
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Public entry — gates the whole section on the serve-wide A2A flag.
// ---------------------------------------------------------------------------

export function A2aPeersSection({ personalityId }: { personalityId: string }) {
  const settingsQuery = useQuery({
    queryKey: ['a2a', 'settings'],
    queryFn: () => rpc.a2a.settings.get(),
    retry: false,
  });

  // Hide while resolving (avoids a flash) and whenever A2A is off/unavailable.
  if (settingsQuery.isLoading) return null;
  if (isNotAvailable(settingsQuery.error) || settingsQuery.error) return null;
  if (!settingsQuery.data?.enabled) return null;

  return <A2aPeersBody personalityId={personalityId} />;
}

// ---------------------------------------------------------------------------
// Section body — identity, peers table, exposed skills.
// ---------------------------------------------------------------------------

function A2aPeersBody({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [addOpen, setAddOpen] = useState(false);

  const identityQuery = useQuery({
    queryKey: ['a2a', 'identity', personalityId],
    queryFn: () => rpc.a2a.identity({ personalityId }),
  });

  const peersQuery = useQuery({
    queryKey: ['a2a', 'peers', personalityId],
    queryFn: () => rpc.a2a.peers.list({ personalityId }),
  });

  const skillsQuery = useQuery({
    queryKey: ['a2a', 'skills', personalityId],
    queryFn: () => rpc.a2a.skills.listExposable({ personalityId }),
  });

  const setEnabledMut = useMutation({
    mutationFn: (input: { fingerprint: string; enabled: boolean }) =>
      rpc.a2a.peers.setEnabled({ personalityId, ...input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['a2a', 'peers', personalityId] });
    },
    onError: (err) =>
      notification.error({ message: 'Failed to update peer', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (fingerprint: string) => rpc.a2a.peers.remove({ personalityId, fingerprint }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['a2a', 'peers', personalityId] });
      notification.success({ message: 'Peer removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Failed to remove peer', description: (err as Error).message }),
  });

  const columns: ColumnsType<A2aPeerRowWire> = [
    {
      title: 'Name',
      key: 'name',
      render: (_: unknown, row) => (
        <Typography.Text>{row.label ?? row.cardName ?? '—'}</Typography.Text>
      ),
    },
    {
      title: 'Fingerprint',
      dataIndex: 'fingerprint',
      key: 'fingerprint',
      render: (fp: string) => (
        <Typography.Text code copyable={{ text: fp }} style={{ fontFamily: MONO, fontSize: 11 }}>
          {shortFingerprint(fp)}
        </Typography.Text>
      ),
    },
    {
      title: 'URL',
      dataIndex: 'url',
      key: 'url',
      render: (url?: string) =>
        url ? (
          <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
            {url}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Access',
      dataIndex: 'access',
      key: 'access',
      width: 80,
      render: (access: 'full') => (
        <Tag bordered={false} style={{ fontSize: 11 }}>
          {access}
        </Tag>
      ),
    },
    {
      title: 'State',
      key: 'state',
      width: 100,
      render: (_: unknown, row) => (
        <Tooltip title={row.enabled ? 'Disable (revoke) this peer' : 'Enable this peer'}>
          <Switch
            size="small"
            checked={row.enabled}
            loading={
              setEnabledMut.isPending && setEnabledMut.variables?.fingerprint === row.fingerprint
            }
            onChange={(enabled) => setEnabledMut.mutate({ fingerprint: row.fingerprint, enabled })}
          />
        </Tooltip>
      ),
    },
    {
      title: 'Last seen',
      dataIndex: 'lastSeenAt',
      key: 'lastSeenAt',
      width: 100,
      render: (lastSeenAt?: number) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatLastSeen(lastSeenAt)}
        </Typography.Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, row) => (
        <Popconfirm
          title={`Remove ${row.label ?? row.cardName ?? 'this peer'}?`}
          description="The peer loses all access immediately."
          onConfirm={() => removeMut.mutate(row.fingerprint)}
          okText="Remove"
          okButtonProps={{ danger: true }}
        >
          <Button size="small" danger loading={removeMut.isPending}>
            Remove
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const identity = identityQuery.data;
  const peers = peersQuery.data ?? [];
  const skills = skillsQuery.data ?? [];

  return (
    <div style={{ marginBottom: 32 }}>
      <Typography.Title level={5} style={{ marginBottom: 12 }}>
        Peers (A2A)
      </Typography.Title>

      {/* My identity — the fingerprint + well-known URL you hand a peer out-of-band. */}
      <IdentityBlock identity={identity} loading={identityQuery.isLoading} />

      {/* Peers table */}
      <div style={{ marginTop: 24 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}
          >
            Peers
          </Typography.Text>
          <Button size="small" onClick={() => setAddOpen(true)} disabled={!identity}>
            + Add peer
          </Button>
        </div>
        <Table<A2aPeerRowWire>
          rowKey="fingerprint"
          columns={columns}
          dataSource={peers}
          size="small"
          pagination={false}
          loading={peersQuery.isLoading}
          locale={{ emptyText: 'No peers yet. Add one your peer has approved you on.' }}
          scroll={{ x: true }}
        />
      </div>

      {/* Exposed skills — read-only in v1; controlled by skill frontmatter. */}
      <div style={{ marginTop: 24 }}>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}
        >
          Exposed skills
        </Typography.Text>
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}
        >
          Exposure is controlled in each skill's frontmatter (
          <Typography.Text code style={{ fontSize: 11 }}>
            exposeToAgents
          </Typography.Text>
          ), not here.
        </Typography.Paragraph>
        {skillsQuery.isLoading ? (
          <Spin size="small" />
        ) : skills.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No skills available to expose.
          </Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {skills.map((skill) => (
              <Checkbox key={skill.name} checked={skill.exposed} disabled>
                <Typography.Text style={{ fontFamily: MONO, fontSize: 12 }}>
                  {skill.name}
                </Typography.Text>
              </Checkbox>
            ))}
          </div>
        )}
      </div>

      {addOpen && identity ? (
        <AddPeerModal
          personalityId={personalityId}
          ownFingerprint={identity.fingerprint}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            qc.invalidateQueries({ queryKey: ['a2a', 'peers', personalityId] });
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// My identity block
// ---------------------------------------------------------------------------

function IdentityRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
      <span style={{ minWidth: 96, fontSize: 12, color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  );
}

function IdentityBlock({
  identity,
  loading,
}: {
  identity: A2aIdentityViewWire | undefined;
  loading: boolean;
}) {
  if (loading) return <Spin size="small" />;
  if (!identity) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Identity unavailable.
      </Typography.Text>
    );
  }
  return (
    <div>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}
      >
        My identity
      </Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        <IdentityRow label="Fingerprint">
          <Typography.Text
            code
            copyable={{ text: identity.fingerprint }}
            style={{ fontFamily: MONO, fontSize: 12 }}
          >
            {identity.fingerprint}
          </Typography.Text>
        </IdentityRow>
        <IdentityRow label="Well-known">
          <Typography.Text
            copyable={{ text: identity.wellKnownUrl }}
            style={{ fontFamily: MONO, fontSize: 12 }}
          >
            {identity.wellKnownUrl}
          </Typography.Text>
        </IdentityRow>
        <IdentityRow label="JSON-RPC">
          <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}>
            {identity.jsonRpcUrl}
          </Typography.Text>
        </IdentityRow>
        <IdentityRow label="Auth">
          <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}>
            {identity.authUrl}
          </Typography.Text>
        </IdentityRow>
        {identity.did ? (
          <IdentityRow label="DID">
            <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}>
              {identity.did}
            </Typography.Text>
          </IdentityRow>
        ) : null}
        <IdentityRow label="Exposed skills">
          {identity.exposedSkills.length > 0 ? (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {identity.exposedSkills.map((s) => (
                <Tag key={s} bordered={false} style={{ margin: 0, fontSize: 11 }}>
                  {s}
                </Tag>
              ))}
            </span>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              none
            </Typography.Text>
          )}
        </IdentityRow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-peer modal — verify-first: fetch the card, then require the out-of-band
// fingerprint to match before the peer can be saved (plan §8).
// ---------------------------------------------------------------------------

function AddPeerModal({
  personalityId,
  ownFingerprint,
  onClose,
  onAdded,
}: {
  personalityId: string;
  ownFingerprint: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { notification } = AntApp.useApp();
  const [url, setUrl] = useState('');
  const [expected, setExpected] = useState('');
  const [label, setLabel] = useState('');
  const [mismatchError, setMismatchError] = useState<string | null>(null);

  const previewMut = useMutation({
    mutationFn: (peerUrl: string) => rpc.a2a.peers.preview({ url: peerUrl }),
  });

  const addMut = useMutation({
    mutationFn: () =>
      rpc.a2a.peers.add({
        personalityId,
        url: url.trim(),
        expectedFingerprint: expected.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: () => {
      notification.success({
        message: 'Added (disabled) — enable it to activate.',
        placement: 'topRight',
      });
      onAdded();
    },
    onError: (err) => {
      if (errorCode(err) === 'FINGERPRINT_MISMATCH') {
        setMismatchError("Fetched fingerprint doesn't match — nothing was saved.");
        return;
      }
      notification.error({ message: 'Failed to add peer', description: (err as Error).message });
    },
  });

  // Editing the URL invalidates any prior preview so a stale fingerprint can't
  // linger behind the match check.
  const handleUrlChange = (next: string) => {
    setUrl(next);
    previewMut.reset();
    setMismatchError(null);
  };

  const preview = previewMut.data;
  const fetched = preview?.fingerprint;
  const matches =
    !!fetched &&
    expected.trim().length > 0 &&
    expected.trim().toLowerCase() === fetched.toLowerCase();

  const fetchPreview = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    previewMut.mutate(trimmed);
  };

  const previewErrorMessage = (() => {
    if (!previewMut.isError) return null;
    const code = errorCode(previewMut.error);
    if (code === 'NOT_FOUND') return 'No agent card found at that URL.';
    if (code === 'A2A_UPSTREAM_ERROR')
      return 'Could not reach the peer — check the URL and try again.';
    return (previewMut.error as Error).message;
  })();

  return (
    <Modal
      open
      title="Add peer"
      onCancel={onClose}
      width={560}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!matches}
            loading={addMut.isPending}
            onClick={() => addMut.mutate()}
          >
            Save
          </Button>
        </div>
      }
    >
      {/* 1. Peer well-known URL → fetch + verify the card. */}
      <div style={{ marginBottom: 16 }}>
        <Typography.Text style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Peer well-known URL
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <Input
            autoFocus
            placeholder="https://peer.example/.well-known/agent-card?personality=…"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            onBlur={fetchPreview}
            onPressEnter={fetchPreview}
            style={{ fontFamily: MONO, fontSize: 12 }}
          />
          <Button loading={previewMut.isPending} onClick={fetchPreview} disabled={!url.trim()}>
            Fetch
          </Button>
        </div>
        {previewErrorMessage ? (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            {previewErrorMessage}
          </Typography.Text>
        ) : null}
      </div>

      {/* Fetched card summary. */}
      {preview ? (
        <div
          style={{
            border: '1px solid var(--border-subtle, #2A2A2A)',
            borderRadius: 'var(--radius-md)',
            padding: 12,
            marginBottom: 16,
          }}
        >
          <Typography.Text strong>{preview.name}</Typography.Text>
          {preview.description ? (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
              {preview.description}
            </Typography.Paragraph>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Fetched fingerprint</span>
            <Typography.Text
              code
              copyable={{ text: preview.fingerprint }}
              style={{ fontFamily: MONO, fontSize: 12 }}
            >
              {preview.fingerprint}
            </Typography.Text>
          </div>
        </div>
      ) : null}

      {/* 2. Expected fingerprint (out-of-band) → live match gate. */}
      <div style={{ marginBottom: 16 }}>
        <Typography.Text style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Expected fingerprint (given to you out-of-band)
        </Typography.Text>
        <Input
          placeholder="441ac7fe…d206"
          value={expected}
          onChange={(e) => {
            setExpected(e.target.value);
            setMismatchError(null);
          }}
          style={{ fontFamily: MONO, fontSize: 12, marginTop: 4 }}
        />
        {mismatchError ? (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            {mismatchError}
          </Typography.Text>
        ) : fetched && expected.trim().length > 0 ? (
          <Typography.Text
            type={matches ? 'success' : 'danger'}
            style={{ fontSize: 12, display: 'block', marginTop: 6 }}
          >
            {matches ? '✓ Matches the fetched fingerprint' : '✗ Does not match — check the value'}
          </Typography.Text>
        ) : (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: 'block', marginTop: 6 }}
          >
            Save unlocks once this matches the fetched fingerprint.
          </Typography.Text>
        )}
      </div>

      {/* 3. Optional local label. */}
      <div style={{ marginBottom: 16 }}>
        <Typography.Text style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Local label (optional)
        </Typography.Text>
        <Input
          placeholder="e.g. EM's swing-trader"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ marginTop: 4 }}
        />
      </div>

      {/* 5. Two-sidedness reminder + copy-my-fingerprint shortcut. */}
      <div
        style={{
          borderTop: '1px solid var(--border-subtle, #2A2A2A)',
          paddingTop: 12,
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          The other agent must also add <em>your</em> fingerprint before calls succeed:
        </Typography.Text>
        <Typography.Text
          code
          copyable={{ text: ownFingerprint }}
          style={{ fontFamily: MONO, fontSize: 12 }}
        >
          {shortFingerprint(ownFingerprint)}
        </Typography.Text>
      </div>
    </Modal>
  );
}
