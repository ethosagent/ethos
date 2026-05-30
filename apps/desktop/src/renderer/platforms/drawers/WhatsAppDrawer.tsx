import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { AccessControlSection } from '../components/AccessControlSection';
import { BotRow } from '../components/BotRow';

interface WhatsAppDrawerProps {
  onBotChange?: () => void;
}

interface WhatsAppBot {
  botKey: string;
  defaultMode: 'all' | 'mention_only';
  allowedNumbers: string[];
  phoneNumber?: string;
  paired: boolean;
}

const microLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  marginBottom: 8,
};

const fieldLabel: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--text-secondary)',
  marginBottom: 4,
  display: 'block',
};

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

export function WhatsAppDrawer({ onBotChange }: WhatsAppDrawerProps) {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [paired, setPaired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bots, setBots] = useState<WhatsAppBot[]>([]);

  const [id, setId] = useState('');
  const [defaultMode, setDefaultMode] = useState<'all' | 'mention_only'>('mention_only');
  const [ownerNumber, setOwnerNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [listResult, botsResult] = await Promise.all([
        client.rpc.platforms.list({}),
        client.rpc.platforms.botsListWhatsApp({}),
      ]);
      const wa = listResult.platforms.find((p) => p.id === 'whatsapp');
      setPaired(wa?.fields?.paired ?? false);
      setBots(botsResult.bots as WhatsAppBot[]);
    } catch {
      setPaired(false);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The first not-yet-paired bot is the one we surface a live pairing code for.
  const unpairedBot = bots.find((b) => !b.paired);

  // While a bot is unpaired, subscribe to its setup SSE so we can show the live
  // 8-char pairing code the gateway emits after a restart. Closes on unmount or
  // once the bot reports paired.
  useEffect(() => {
    if (!unpairedBot) {
      setPairingCode(null);
      return;
    }
    const source = new EventSource(`${baseUrl}/setup/whatsapp/${unpairedBot.botKey}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.paired) {
          setPairingCode(null);
          source.close();
        } else if (data.pairingCode) {
          setPairingCode(data.pairingCode);
        }
      } catch {
        // ignore malformed events
      }
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [unpairedBot, baseUrl]);

  const canEnable =
    id.trim().length > 0 &&
    ownerNumber.trim().length > 0 &&
    phoneNumber.trim().length > 0 &&
    !enabling;

  const handleEnable = useCallback(async () => {
    if (!canEnable) return;
    setEnabling(true);
    setError('');
    try {
      await client.rpc.platforms.botsAddWhatsApp({
        id: id.trim(),
        defaultMode,
        phoneNumber: phoneNumber.trim(),
      });
      // Owner number lives on the channel filter, not the bot entry. Read the
      // current filter first so we don't clobber the allowlist or enabled flag.
      const current = await client.rpc.platforms.getChannelFilter({ platform: 'whatsapp' });
      const ownerUserId = `${ownerNumber.trim()}@s.whatsapp.net`;
      await client.rpc.platforms.setChannelFilter({
        platform: 'whatsapp',
        filter: { ...current.filter, ownerUserId },
      });
      setId('');
      setOwnerNumber('');
      setPhoneNumber('');
      setDefaultMode('mention_only');
      await reload();
      onBotChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnabling(false);
    }
  }, [canEnable, client, id, defaultMode, ownerNumber, phoneNumber, reload, onBotChange]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await window.ethos.backend.restart();
    } finally {
      setRestarting(false);
    }
  }, []);

  const handleRemove = useCallback(
    async (botKey: string) => {
      try {
        await client.rpc.platforms.botsRemoveWhatsApp({ botKey });
        await reload();
        onBotChange?.();
      } catch {
        // Best-effort removal — list refreshes on next poll
      }
    },
    [client, reload, onBotChange],
  );

  const statusDot = paired ? 'var(--success)' : 'var(--text-tertiary)';
  const statusText = loading ? 'Checking...' : paired ? 'Paired' : 'Not paired';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={microLabel}>STATUS</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: statusDot,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{statusText}</span>
        </div>
      </div>

      {bots.length > 0 && (
        <div>
          <div style={microLabel}>ENABLED BOTS</div>
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            {bots.map((bot) => (
              <BotRow
                key={bot.botKey}
                username={bot.botKey}
                personalityName={bot.defaultMode}
                personalityAccent="var(--accent)"
                status={bot.paired ? 'connected' : 'disconnected'}
                onRemove={() => handleRemove(bot.botKey)}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={microLabel}>ENABLE WHATSAPP</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <span style={fieldLabel}>Name / ID</span>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="default"
              style={inputStyle}
            />
          </div>

          <div>
            <span style={fieldLabel}>Reply mode</span>
            <select
              value={defaultMode}
              onChange={(e) => setDefaultMode(e.target.value as 'all' | 'mention_only')}
              style={inputStyle}
            >
              <option value="mention_only">Mention only</option>
              <option value="all">All messages</option>
            </select>
          </div>

          <div>
            <span style={fieldLabel}>Phone number to link</span>
            <input
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="14155551234"
              style={inputStyle}
            />
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              The WhatsApp number this bot links to, E.164 without the + (e.g. 14155551234). You'll
              enter a pairing code on this phone after restarting.
            </div>
          </div>

          <div>
            <span style={fieldLabel}>Owner number</span>
            <input
              type="text"
              value={ownerNumber}
              onChange={(e) => setOwnerNumber(e.target.value)}
              placeholder="14155551234"
              style={inputStyle}
            />
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              E.164 format without the + (e.g. 14155551234). Only this number can talk to the bot
              until you add more under Access Control.
            </div>
          </div>

          <button
            type="button"
            disabled={!canEnable}
            onClick={handleEnable}
            style={{
              width: '100%',
              height: 36,
              borderRadius: 4,
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              cursor: canEnable ? 'pointer' : 'not-allowed',
              opacity: canEnable ? 1 : 0.4,
            }}
          >
            {enabling ? 'Enabling...' : 'Enable WhatsApp'}
          </button>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--error)', padding: '8px 0' }}>{error}</div>
          )}
        </div>
      </div>

      {pairingCode && unpairedBot && (
        <div>
          <div style={microLabel}>PAIRING CODE</div>
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: 16,
              backgroundColor: 'var(--bg-elevated)',
            }}
          >
            <code
              style={{
                display: 'block',
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '0.18em',
                color: 'var(--text-primary)',
                userSelect: 'all',
              }}
            >
              {pairingCode}
            </code>
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: 12,
                lineHeight: 1.6,
              }}
            >
              On the phone for <strong>{unpairedBot.phoneNumber ?? 'the number you linked'}</strong>
              : WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device &rarr; Link with
              phone number instead, then enter this code.
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          backgroundColor: 'var(--bg-elevated)',
          borderRadius: 8,
          padding: 12,
          lineHeight: 1.6,
        }}
      >
        Restart the gateway (or re-run <code style={{ fontSize: 11 }}>ethos serve</code>) to apply,
        then enter the pairing code shown above:
        <div style={{ marginTop: 8 }}>
          1. The pairing code appears here once the gateway is back, or visit{' '}
          <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            http://localhost:{state.port}/setup/whatsapp/
            {unpairedBot?.botKey ?? 'default'}
          </code>
        </div>
        <div>
          2. Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device &rarr; Link
          with phone number instead
        </div>
        <div>3. Enter the pairing code on your phone (or scan the terminal QR as a fallback)</div>
        <button
          type="button"
          disabled={restarting}
          onClick={handleRestart}
          style={{
            marginTop: 12,
            width: '100%',
            height: 36,
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-base)',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontWeight: 500,
            cursor: restarting ? 'not-allowed' : 'pointer',
            opacity: restarting ? 0.4 : 1,
          }}
        >
          {restarting ? 'Restarting gateway...' : 'Restart gateway'}
        </button>
        <div style={{ marginTop: 8, color: 'var(--text-tertiary)' }}>
          The pairing code will appear here once the backend is back.
        </div>
      </div>

      <AccessControlSection platform="whatsapp" client={client} />

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
