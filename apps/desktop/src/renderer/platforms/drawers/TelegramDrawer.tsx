import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { PersonalityBindingRow } from '../../ui/PersonalityBindingRow';
import { AccessControlSection } from '../components/AccessControlSection';
import { BotRow } from '../components/BotRow';
import { TokenInput } from '../components/TokenInput';

interface TelegramBot {
  botKey: string;
  tokenConfigured: boolean;
  bind: { type: 'personality' | 'team'; name: string };
}

interface TelegramDrawerProps {
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

export function TelegramDrawer({ onBotChange }: TelegramDrawerProps) {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [bots, setBots] = useState<TelegramBot[]>([]);
  const [token, setToken] = useState('');
  const [validatedUsername, setValidatedUsername] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const loadBots = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.botsListTelegram({});
      setBots(result.bots as TelegramBot[]);
    } catch {
      // Backend may not support this yet
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
      const result = await (window as any).ethos.platformTest.telegram({ token: token.trim() });
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
      await client.rpc.platforms.botsAddTelegram({
        token: token.trim(),
        bind: { type: 'personality', name: personalityId },
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

  const handleRemove = useCallback(
    async (botKey: string) => {
      try {
        await client.rpc.platforms.botsRemoveTelegram({ botKey });
        await loadBots();
        onBotChange?.();
      } catch {
        // Silently fail — bot list will refresh on next poll
      }
    },
    [client, loadBots, onBotChange],
  );

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
                key={bot.botKey}
                username={bot.botKey}
                personalityName={bot.bind.name}
                personalityAccent="var(--accent)"
                status={bot.tokenConfigured ? 'connected' : 'disconnected'}
                onRemove={() => handleRemove(bot.botKey)}
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
          <div>
            1. Open Telegram and search for <strong>@BotFather</strong>
          </div>
          <div>
            2. Send <code>/newbot</code> and follow the prompts to name your bot
          </div>
          <div>
            3. Copy the API token BotFather gives you (looks like <code>1234567890:AABB...</code>)
          </div>
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
              placeholder="Paste bot token"
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
            Bot: @{validatedUsername} ✓
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
          {connecting ? 'Connecting...' : 'Connect bot'}
        </button>

        {connectError && (
          <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>{connectError}</div>
        )}
      </div>

      <AccessControlSection platform="telegram" client={client} />

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
