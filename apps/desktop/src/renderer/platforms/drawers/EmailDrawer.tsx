import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { PersonalityBindingRow } from '../../ui/PersonalityBindingRow';
import { Toggle } from '../../ui/Toggle';
import { AccessControlSection } from '../components/AccessControlSection';
import { TokenInput } from '../components/TokenInput';

interface EmailDrawerProps {
  onBotChange?: () => void;
}

type Tab = 'receive' | 'send';

const CHECK_INTERVALS = [
  { label: '1 minute', value: '1' },
  { label: '5 minutes', value: '5' },
  { label: '15 minutes', value: '15' },
  { label: '30 minutes', value: '30' },
];

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--text-primary)',
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '0 10px',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginBottom: 4,
};

export function EmailDrawer({ onBotChange }: EmailDrawerProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [activeTab, setActiveTab] = useState<Tab>('receive');

  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUser, setImapUser] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [tls, setTls] = useState(true);
  const [checkInterval, setCheckInterval] = useState('5');
  const [imapTestStatus, setImapTestStatus] = useState<string | null>(null);
  const [imapTestError, setImapTestError] = useState<string | null>(null);
  const [imapTesting, setImapTesting] = useState(false);

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [starttls, setStarttls] = useState(true);
  const [smtpTestStatus, setSmtpTestStatus] = useState<string | null>(null);
  const [smtpTestError, setSmtpTestError] = useState<string | null>(null);
  const [smtpTesting, setSmtpTesting] = useState(false);

  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleImapTest = useCallback(async () => {
    setImapTesting(true);
    setImapTestStatus(null);
    setImapTestError(null);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Electron preload bridge
      const result = await (window as any).ethos.platformTest.imap({
        host: imapHost,
        port: Number(imapPort),
        user: imapUser,
        password: imapPassword,
        tls,
      });
      if (result.ok) {
        setImapTestStatus('Connected ✓');
      } else {
        setImapTestError(result.error ?? 'Connection failed');
      }
    } catch (err) {
      setImapTestError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setImapTesting(false);
    }
  }, [imapHost, imapPort, imapUser, imapPassword, tls]);

  const handleSmtpTest = useCallback(async () => {
    setSmtpTesting(true);
    setSmtpTestStatus(null);
    setSmtpTestError(null);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Electron preload bridge
      const result = await (window as any).ethos.platformTest.smtp({
        host: smtpHost,
        port: Number(smtpPort),
        user: smtpUser,
        password: smtpPassword,
        starttls,
      });
      if (result.ok) {
        setSmtpTestStatus('Connected ✓');
      } else {
        setSmtpTestError(result.error ?? 'Connection failed');
      }
    } catch (err) {
      setSmtpTestError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setSmtpTesting(false);
    }
  }, [smtpHost, smtpPort, smtpUser, smtpPassword, starttls]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await client.rpc.platforms.set({
        id: 'email',
        fields: {
          imapHost,
          imapPort,
          imapUser,
          imapPassword,
          imapTls: String(tls),
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPassword,
          smtpStarttls: String(starttls),
          checkInterval,
          personalityId: personalityId ?? '',
        },
      });
      onBotChange?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [
    client,
    imapHost,
    imapPort,
    imapUser,
    imapPassword,
    tls,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPassword,
    starttls,
    checkInterval,
    personalityId,
    onBotChange,
  ]);

  const showGmailNote =
    (activeTab === 'receive' && imapUser.endsWith('@gmail.com')) ||
    (activeTab === 'send' && smtpUser.endsWith('@gmail.com'));

  const tabButton = (tab: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setActiveTab(tab)}
      style={{
        flex: 1,
        height: 32,
        background: 'none',
        border: 'none',
        borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
        color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 0 }}>
        {tabButton('receive', 'Receive')}
        {tabButton('send', 'Send')}
      </div>

      {activeTab === 'receive' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={labelStyle}>Host</div>
            <input
              type="text"
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              placeholder="imap.gmail.com"
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ width: 70 }}>
              <div style={labelStyle}>Port</div>
              <input
                type="text"
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
                placeholder="993"
                style={{ ...inputStyle, width: 70 }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 36,
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>SSL/TLS</span>
              <Toggle checked={tls} onChange={setTls} />
            </div>
          </div>

          <div>
            <div style={labelStyle}>Username</div>
            <input
              type="text"
              value={imapUser}
              onChange={(e) => setImapUser(e.target.value)}
              placeholder="you@gmail.com"
              style={{ ...inputStyle, fontFamily: 'var(--font-display)' }}
            />
          </div>

          <div>
            <div style={labelStyle}>Password</div>
            <TokenInput
              value={imapPassword}
              onChange={setImapPassword}
              placeholder="App password..."
            />
          </div>

          <div>
            <div style={labelStyle}>Check every</div>
            <select
              value={checkInterval}
              onChange={(e) => setCheckInterval(e.target.value)}
              style={{
                width: 120,
                height: 36,
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                color: 'var(--text-primary)',
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                padding: '0 8px',
                outline: 'none',
                appearance: 'auto',
              }}
            >
              {CHECK_INTERVALS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={handleImapTest}
              disabled={imapTesting}
              style={{
                height: 28,
                borderRadius: 4,
                border: '1px solid var(--border-subtle)',
                background: 'none',
                color: 'var(--text-secondary)',
                fontSize: 12,
                padding: '0 12px',
                cursor: imapTesting ? 'not-allowed' : 'pointer',
                opacity: imapTesting ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {imapTesting ? 'Testing...' : 'Test connection'}
            </button>
            {imapTestStatus && (
              <span style={{ fontSize: 12, color: 'var(--success)' }}>{imapTestStatus}</span>
            )}
            {imapTestError && (
              <span style={{ fontSize: 12, color: 'var(--error)' }}>{imapTestError}</span>
            )}
          </div>
        </div>
      )}

      {activeTab === 'send' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={labelStyle}>Host</div>
            <input
              type="text"
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.gmail.com"
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ width: 70 }}>
              <div style={labelStyle}>Port</div>
              <input
                type="text"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                placeholder="587"
                style={{ ...inputStyle, width: 70 }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 36,
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>STARTTLS</span>
              <Toggle checked={starttls} onChange={setStarttls} />
            </div>
          </div>

          <div>
            <div style={labelStyle}>Username</div>
            <input
              type="text"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              placeholder="you@gmail.com"
              style={{ ...inputStyle, fontFamily: 'var(--font-display)' }}
            />
          </div>

          <div>
            <div style={labelStyle}>Password</div>
            <TokenInput
              value={smtpPassword}
              onChange={setSmtpPassword}
              placeholder="App password..."
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={handleSmtpTest}
              disabled={smtpTesting}
              style={{
                height: 28,
                borderRadius: 4,
                border: '1px solid var(--border-subtle)',
                background: 'none',
                color: 'var(--text-secondary)',
                fontSize: 12,
                padding: '0 12px',
                cursor: smtpTesting ? 'not-allowed' : 'pointer',
                opacity: smtpTesting ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {smtpTesting ? 'Testing...' : 'Test connection'}
            </button>
            {smtpTestStatus && (
              <span style={{ fontSize: 12, color: 'var(--success)' }}>{smtpTestStatus}</span>
            )}
            {smtpTestError && (
              <span style={{ fontSize: 12, color: 'var(--error)' }}>{smtpTestError}</span>
            )}
          </div>
        </div>
      )}

      {showGmailNote && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--info)',
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 8,
            padding: 12,
            lineHeight: 1.5,
          }}
        >
          Gmail requires an App Password when 2-Step Verification is enabled. Generate one at{' '}
          myaccount.google.com/apppasswords.
        </div>
      )}

      <PersonalityBindingRow
        value={personalityId}
        onChange={setPersonalityId}
        label="Which agent responds to emails?"
      />

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%',
          height: 36,
          borderRadius: 4,
          border: 'none',
          backgroundColor: 'var(--accent)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 500,
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.7 : 1,
        }}
      >
        {saving ? 'Saving...' : 'Save email config'}
      </button>

      {saveError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{saveError}</div>}

      <AccessControlSection platform="email" client={client} />

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-tertiary)',
          fontStyle: 'italic',
        }}
      >
        The gateway runs inside Ethos. Keep the app running or minimized to the tray for this bot to
        stay online.
      </div>
    </div>
  );
}
