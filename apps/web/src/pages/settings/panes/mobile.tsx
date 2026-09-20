// Settings → Mobile app — connect a phone from the web
// (plan/phases/mobile-app.md T-WEB, S7, S13, D3).
//
// Two sections, both dense rows — not a `Card` (DESIGN.md "Cards earn
// existence"). "Connect a phone" mints a phone-scoped API key through the
// existing `apiKeys.create` (no new mint RPC) and renders it as a QR the
// phone scans; "Connected phones" is the same `apiKeys.list`, filtered to
// phone-shaped keys and joined against `push.listDevices` (S13).
//
// Every outcome on this page is a row that resolves IN PLACE — no toast, and
// no second status vocabulary. Rows whose meaning fits the shared
// `FeedbackRow` states (ok/failed/unrecorded) use it directly; the ones this
// page invents ("waiting", "connected", "not connected yet", "install",
// "never used") are drawn with the same `.activity-row` markup `backup.tsx`'s
// store/archive rows use for the same reason — the row LANGUAGE, not a fork
// of it.
//
// The pure connect state machine (idle → generating → revealed → connected |
// expired) and the phone-key predicate live in `../lib/mobile-connect.ts`,
// DOM-free and unit-tested on their own — this file only wires them to
// `apiKeys.*`/`push.*` and renders them.
//
// The secret is never written anywhere but this component's own state: the
// `apiKeys.create` mutation result is read once into `connectState`, and the
// QR/key fields are removed from the page for good once the phone connects
// or 10 minutes pass with no connect (`applyLastUsed`/`applyTimeout`).

import type { ApiKeyMetadata, PushDeviceRow } from '@ethosagent/web-contracts';
import { PHONE_PRESET_SCOPES } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, QRCode, Skeleton, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { FeedbackRow } from '../../../components/ui/FeedbackRow';
import { rpc } from '../../../rpc';
import { SectionHeading } from '../components/section-heading';
import { SelfSaveMarker } from '../components/self-save-marker';
import {
  applyLastUsed,
  applyTimeout,
  buildConnectString,
  canGenerateQr,
  IDLE_STATE,
  isPhoneKey,
  type MobileConnectInfo,
  type MobileConnectState,
  resetConnect,
  reveal,
  startGenerating,
} from '../lib/mobile-connect';

/** `HH:MM` — every clock time on this page (connected, revoked, last seen). */
function clockTime(at: number | string): string {
  const d = typeof at === 'number' ? new Date(at) : new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** This page's own row vocabulary — same `.activity-row` markup as `FeedbackRow`,
 *  a custom glyph + word (backup.tsx's store/archive rows do the same). */
function MobileRow({
  glyph,
  word,
  subject,
  result,
  meta,
}: {
  glyph: string;
  word: string;
  subject: string;
  result?: string;
  meta?: string;
}) {
  return (
    <div className="activity-row">
      <span className="activity-row-state">
        <span aria-hidden="true">{glyph}</span> {word}
      </span>
      <span className="activity-row-subject">{subject}</span>
      {result ? <span className="activity-row-result">{result}</span> : null}
      {meta ? <span className="activity-row-meta">{meta}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect a phone
// ---------------------------------------------------------------------------

function ConnectAPhoneSection() {
  const qc = useQueryClient();
  const [deviceName, setDeviceName] = useState('iPhone');
  const [hostUrl, setHostUrl] = useState<string | null>(null);
  const [connectState, setConnectState] = useState<MobileConnectState>(IDLE_STATE);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [unblurred, setUnblurred] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const connectInfoQuery = useQuery({
    queryKey: ['meta', 'connectInfo'],
    queryFn: () => rpc.meta.connectInfo(),
  });
  const info: MobileConnectInfo | undefined = connectInfoQuery.data;

  // Prefill the editable host once, from the resolved URL — never overwrite
  // an operator edit on a later refetch.
  useEffect(() => {
    if (hostUrl === null && info) setHostUrl(info.url);
  }, [info, hostUrl]);

  const createMut = useMutation({
    mutationFn: () =>
      rpc.apiKeys.create({
        name: deviceName,
        scopes: [...PHONE_PRESET_SCOPES],
        allowedOrigins: [],
      }),
  });

  // Polls `apiKeys.list` every 2s while a key is out and unconnected — the
  // phone's first authenticated call (`meta.whoami`) flips `lastUsed`.
  const pollQuery = useQuery({
    queryKey: ['apiKeys'],
    queryFn: () => rpc.apiKeys.list({}),
    refetchInterval: connectState.phase === 'revealed' ? 2000 : false,
  });

  useEffect(() => {
    if (connectState.phase !== 'revealed' || !connectState.keyId) return;
    const row = pollQuery.data?.items.find((k) => k.id === connectState.keyId);
    if (!row) return;
    const next = applyLastUsed(connectState, row.lastUsed);
    if (next !== connectState) {
      setConnectedAt(Date.now());
      setConnectState(next);
    }
  }, [pollQuery.data, connectState]);

  // The 10-minute wait — checked on a slow tick, not tied to the 2s poll.
  useEffect(() => {
    if (connectState.phase !== 'revealed') return;
    const id = setInterval(() => setConnectState((s) => applyTimeout(s, Date.now())), 5000);
    return () => clearInterval(id);
  }, [connectState.phase]);

  const handleGenerate = () => {
    setKeyError(null);
    setUnblurred(false);
    setConnectState(startGenerating());
    createMut.mutate(undefined, {
      onSuccess: (data) => {
        setConnectState(
          reveal({
            keyId: data.key.id,
            url: hostUrl ?? info?.url ?? '',
            key: data.secret,
            now: Date.now(),
          }),
        );
        qc.invalidateQueries({ queryKey: ['apiKeys'] });
      },
      onError: (err) => {
        setKeyError((err as Error).message);
        setConnectState(IDLE_STATE);
      },
    });
  };

  if (connectInfoQuery.isLoading || !info) {
    return (
      <>
        <SectionHeading id="connect-a-phone">connect a phone</SectionHeading>
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      </>
    );
  }

  if (connectInfoQuery.error) {
    return (
      <>
        <SectionHeading id="connect-a-phone">connect a phone</SectionHeading>
        <FeedbackRow
          status="failed"
          subject="meta.connectInfo"
          result={(connectInfoQuery.error as Error).message}
        />
      </>
    );
  }

  return (
    <>
      <SectionHeading id="connect-a-phone">connect a phone</SectionHeading>

      {!canGenerateQr(info) ? (
        <>
          <FeedbackRow
            status="failed"
            subject="reachable"
            result="bound to 127.0.0.1 · set web.host"
          />
          <Typography.Paragraph type="secondary">
            <code>web.host: 0.0.0.0</code> (or this machine&rsquo;s tailnet/LAN address) makes it
            reachable, or set <code>webBaseUrl</code> for a reverse proxy or{' '}
            <code>tailscale serve</code>. Restart Ethos after editing. See the &ldquo;Connect your
            phone&rdquo; how-to.
          </Typography.Paragraph>
        </>
      ) : (
        <>
          <FeedbackRow
            status="ok"
            subject="reachable"
            result={`${info.url} · from ${info.source}`}
          />
          <SelfSaveMarker />

          {connectState.phase === 'idle' || connectState.phase === 'generating' ? (
            <div className="settings-mobile-generate">
              <Input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="iPhone"
                style={{ maxWidth: 240 }}
              />
              <Input
                value={hostUrl ?? info.url}
                onChange={(e) => setHostUrl(e.target.value)}
                style={{ fontFamily: 'Geist Mono, monospace', maxWidth: 360 }}
              />
              <Button
                type="primary"
                disabled={connectState.phase === 'generating'}
                onClick={handleGenerate}
                style={{ minHeight: 44 }}
              >
                {connectState.phase === 'generating' ? 'Generating…' : 'Generate QR code'}
              </Button>
            </div>
          ) : null}

          {keyError ? <FeedbackRow status="failed" subject="key" result={keyError} /> : null}

          {connectState.phase === 'revealed' && connectState.url && connectState.key ? (
            <div className="settings-mobile-qr">
              <div style={{ filter: unblurred ? 'none' : 'blur(8px)', display: 'inline-block' }}>
                <QRCode value={buildConnectString(connectState.url, connectState.key)} size={176} />
              </div>
              {!unblurred ? (
                <Button onClick={() => setUnblurred(true)}>Reveal</Button>
              ) : (
                <>
                  <Typography.Paragraph type="secondary">
                    It carries the server URL and the key; nothing else.
                  </Typography.Paragraph>
                  <Typography.Paragraph copyable={{ text: connectState.url }}>
                    <code>{connectState.url}</code>
                  </Typography.Paragraph>
                  <Typography.Paragraph copyable={{ text: connectState.key }}>
                    <code>{connectState.key}</code>
                  </Typography.Paragraph>
                </>
              )}
              <Typography.Paragraph type="secondary">
                This key lets the phone read, approve and talk. It cannot change agents or settings.
              </Typography.Paragraph>
              <MobileRow
                glyph="·"
                word="waiting"
                subject={deviceName}
                result="scan with the Ethos app"
              />
            </div>
          ) : null}

          {connectState.phase === 'connected' ? (
            <MobileRow
              glyph="✓"
              word="connected"
              subject={deviceName}
              meta={connectedAt ? clockTime(connectedAt) : undefined}
            />
          ) : null}

          {connectState.phase === 'expired' ? (
            <MobileRow
              glyph="·"
              word="not connected yet"
              subject={deviceName}
              result="key kept — revoke it below if unused"
            />
          ) : null}

          {connectState.phase === 'connected' || connectState.phase === 'expired' ? (
            <Button size="small" onClick={() => setConnectState(resetConnect())}>
              Connect another phone
            </Button>
          ) : null}

          <MobileRow
            glyph="·"
            word="install"
            subject="TestFlight"
            result="ask the owner for an invite"
          />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Connected phones
// ---------------------------------------------------------------------------

function ConnectedPhonesSection() {
  const qc = useQueryClient();
  const { modal } = AntApp.useApp();
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [revokedRows, setRevokedRows] = useState<Record<string, string>>({});

  const keysQuery = useQuery({ queryKey: ['apiKeys'], queryFn: () => rpc.apiKeys.list({}) });
  const devicesQuery = useQuery({
    queryKey: ['push', 'listDevices'],
    queryFn: () => rpc.push.listDevices({}),
  });

  const testMut = useMutation({ mutationFn: (apiKeyId: string) => rpc.push.test({ apiKeyId }) });
  const revokeMut = useMutation({ mutationFn: (id: string) => rpc.apiKeys.revoke({ id }) });

  const handleTest = (key: ApiKeyMetadata) => {
    testMut.mutate(key.id, {
      onSuccess: (res) =>
        setTestResult((prev) => ({
          ...prev,
          [key.id]: res.ok ? { ok: true, text: 'sent' } : { ok: false, text: res.error },
        })),
      onError: (err) =>
        setTestResult((prev) => ({
          ...prev,
          [key.id]: { ok: false, text: (err as Error).message },
        })),
    });
  };

  const handleRevoke = (key: ApiKeyMetadata) => {
    modal.confirm({
      title: 'Revoke phone',
      content: `Revoke "${key.name}"? The phone loses access immediately.`,
      okText: 'Revoke',
      okButtonProps: { danger: true },
      onOk: () =>
        revokeMut.mutate(key.id, {
          onSuccess: () => {
            setRevokedRows((prev) => ({ ...prev, [key.id]: clockTime(Date.now()) }));
            qc.invalidateQueries({ queryKey: ['apiKeys'] });
          },
        }),
    });
  };

  if (keysQuery.isLoading || devicesQuery.isLoading) {
    return (
      <>
        <SectionHeading id="connected-phones">connected phones</SectionHeading>
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      </>
    );
  }

  const phones = (keysQuery.data?.items ?? []).filter(isPhoneKey);
  const devices = devicesQuery.data ?? [];

  return (
    <>
      <SectionHeading id="connected-phones">connected phones</SectionHeading>
      <SelfSaveMarker />
      {phones.length === 0 ? (
        <div className="settings-mobile-empty">
          No phones connected.{' '}
          <Button
            type="link"
            size="small"
            onClick={() =>
              document.getElementById('connect-a-phone')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            Connect a phone
          </Button>
        </div>
      ) : (
        phones.map((key) => (
          <PhoneRow
            key={key.id}
            phoneKey={key}
            device={devices.find((d) => d.apiKeyId === key.id)}
            testResult={testResult[key.id]}
            revokedAt={revokedRows[key.id]}
            onTest={() => handleTest(key)}
            onRevoke={() => handleRevoke(key)}
            testing={testMut.isPending}
            revoking={revokeMut.isPending}
          />
        ))
      )}
    </>
  );
}

function PhoneRow({
  phoneKey,
  device,
  testResult,
  revokedAt,
  onTest,
  onRevoke,
  testing,
  revoking,
}: {
  phoneKey: ApiKeyMetadata;
  device: PushDeviceRow | undefined;
  testResult: { ok: boolean; text: string } | undefined;
  /** Set once this row's own Revoke resolved — the row that was running becomes the row that
   *  says what happened, same as `backup.tsx`'s action rows (§7, "nothing vanishes"). */
  revokedAt: string | undefined;
  onTest: () => void;
  onRevoke: () => void;
  testing: boolean;
  revoking: boolean;
}) {
  if (revokedAt) {
    return <MobileRow glyph="✗" word="revoked" subject={phoneKey.name} meta={revokedAt} />;
  }

  const deviceText =
    phoneKey.lastUsed === null
      ? 'never used'
      : device
        ? `last seen ${clockTime(device.lastRegisteredAt)} · push registered · app ${device.appVersion}`
        : 'push · not registered';

  return (
    <div className="settings-mobile-phone">
      <MobileRow glyph="✓" word={phoneKey.name} subject={phoneKey.prefix} result={deviceText} />
      {testResult ? (
        <FeedbackRow
          status={testResult.ok ? 'ok' : 'failed'}
          subject="push"
          result={testResult.text}
        />
      ) : null}
      <Button size="small" onClick={onTest} disabled={testing || !device}>
        Send test notification
      </Button>
      <Button size="small" danger onClick={onRevoke} disabled={revoking}>
        Revoke
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function MobilePane() {
  return (
    <>
      <ConnectAPhoneSection />
      <ConnectedPhonesSection />
    </>
  );
}
