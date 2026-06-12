import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { PersonalityBindingRow } from '../../ui/PersonalityBindingRow';
import { AccessControlSection } from '../components/AccessControlSection';
import { BotRow } from '../components/BotRow';
import { TokenInput } from '../components/TokenInput';

interface DiscordBotInfo {
  username: string;
  personalityId: string;
  personalityName: string;
}

interface DiscordDrawerProps {
  onBotChange?: () => void;
}

const microLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  marginBottom: 8,
};

export function DiscordDrawer({ onBotChange }: DiscordDrawerProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [bots, setBots] = useState<DiscordBotInfo[]>([]);
  const [token, setToken] = useState('');
  const [validatedUsername, setValidatedUsername] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const loadBots = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.list({});
      const discord = result.platforms.find((p) => p.id === 'discord' && p.configured);
      if (discord) {
        setBots([
          {
            username: 'Discord Bot',
            personalityId: 'discord',
            personalityName: 'Discord',
          },
        ]);
      } else {
        setBots([]);
      }
    } catch {
      setBots([]);
    }
  }, [client]);

  useEffect(() => {
    loadBots();
  }, [loadBots]);

  const handleValidate = useCallback(async () => {
    if (!token.trim()) return;
    setValidating(true);
    setValidationError(null);
    setValidatedUsername(null);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Electron preload bridge
      const result = await (window as any).ethos.platformTest.discord({ token: token.trim() });
      if (result.ok && result.username) {
        setValidatedUsername(result.username);
      } else {
        setValidationError(result.error ?? 'Validation failed');
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setValidating(false);
    }
  }, [token]);

  const handleConnect = useCallback(async () => {
    if (!validatedUsername || !personalityId) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await client.rpc.platforms.set({
        id: 'discord',
        fields: { token: token.trim(), personalityId },
      });
      setToken('');
      setValidatedUsername(null);
      setPersonalityId(null);
      await loadBots();
      onBotChange?.();
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect bot');
    } finally {
      setConnecting(false);
    }
  }, [client, token, validatedUsername, personalityId, loadBots, onBotChange]);

  const handleRemove = useCallback(async () => {
    try {
      await client.rpc.platforms.clear({ id: 'discord' });
      await loadBots();
      onBotChange?.();
    } catch {}
  }, [client, loadBots, onBotChange]);

  const canConnect = validatedUsername !== null && personalityId !== null && !connecting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {bots.length > 0 && (
        <div>
          <div style={microLabel}>ACTIVE BOTS</div>
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            {bots.map((bot) => (
              <BotRow
                key={bot.personalityId}
                username={bot.username}
                personalityName={bot.personalityName}
                personalityAccent="var(--accent)"
                status="connected"
                onRemove={handleRemove}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={microLabel}>ADD BOT</div>

        <div
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 8,
            padding: '12px 16px',
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginBottom: 16,
            lineHeight: 1.6,
          }}
        >
          <div>1. Go to discord.com/developers/applications</div>
          <div>2. Create an application and add a bot</div>
          <div>3. Copy the bot token from Bot → Token</div>
          <div>
            4. Invite the bot to your server using the OAuth2 URL generator (select &quot;bot&quot;
            scope + desired permissions)
          </div>
        </div>

        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginBottom: 4,
          }}
        >
          Bot token
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <TokenInput
              value={token}
              onChange={(v) => {
                setToken(v);
                setValidatedUsername(null);
                setValidationError(null);
              }}
              placeholder="MTAz..."
              disabled={validating}
            />
          </div>
          <button
            type="button"
            onClick={handleValidate}
            disabled={!token.trim() || validating}
            style={{
              height: 28,
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              background: 'none',
              color: 'var(--text-secondary)',
              fontSize: 12,
              padding: '0 12px',
              cursor: !token.trim() || validating ? 'not-allowed' : 'pointer',
              opacity: !token.trim() || validating ? 0.5 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {validating ? 'Validating...' : 'Validate'}
          </button>
        </div>

        {validatedUsername && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--success)',
              marginBottom: 12,
            }}
          >
            Bot: {validatedUsername} ✓
          </div>
        )}

        {validationError && (
          <div style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>
            {validationError}
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <PersonalityBindingRow value={personalityId} onChange={setPersonalityId} />
        </div>

        <button
          type="button"
          onClick={handleConnect}
          disabled={!canConnect}
          style={{
            width: '100%',
            height: 36,
            borderRadius: 4,
            border: 'none',
            backgroundColor: canConnect ? 'var(--accent)' : 'var(--bg-elevated)',
            color: canConnect ? '#fff' : 'var(--text-tertiary)',
            fontSize: 13,
            fontWeight: 500,
            cursor: canConnect ? 'pointer' : 'not-allowed',
          }}
        >
          {connecting ? 'Connecting...' : 'Connect'}
        </button>

        {connectError && (
          <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>{connectError}</div>
        )}
      </div>

      <AccessControlSection platform="discord" client={client} />

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
