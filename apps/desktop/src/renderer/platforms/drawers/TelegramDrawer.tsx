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
  username?: string;
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

  const [editingBotKey, setEditingBotKey] = useState<string | null>(null);
  const [replaceToken, setReplaceToken] = useState('');
  const [replaceValidatedUsername, setReplaceValidatedUsername] = useState<string | null>(null);
  const [replaceValidating, setReplaceValidating] = useState(false);
  const [replaceValidationError, setReplaceValidationError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);

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
        username: validatedUsername ?? undefined,
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

  const handleReplaceValidate = useCallback(async () => {
    if (!replaceToken.trim()) return;
    setReplaceValidating(true);
    setReplaceValidationError(null);
    setReplaceValidatedUsername(null);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Electron preload bridge
      const result = await (window as any).ethos.platformTest.telegram({
        token: replaceToken.trim(),
      });
      if (result.ok && result.username) {
        setReplaceValidatedUsername(result.username);
      } else {
        setReplaceValidationError(result.error ?? 'Validation failed');
      }
    } catch (err) {
      setReplaceValidationError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setReplaceValidating(false);
    }
  }, [replaceToken]);

  const handleReplace = useCallback(async () => {
    if (!editingBotKey || !replaceValidatedUsername) return;
    const bot = bots.find((b) => b.botKey === editingBotKey);
    if (!bot) return;
    setReplacing(true);
    setReplaceError(null);
    try {
      await client.rpc.platforms.botsRemoveTelegram({ botKey: editingBotKey });
      await client.rpc.platforms.botsAddTelegram({
        token: replaceToken.trim(),
        bind: bot.bind,
        username: replaceValidatedUsername,
      });
      setEditingBotKey(null);
      setReplaceToken('');
      setReplaceValidatedUsername(null);
      await loadBots();
      onBotChange?.();
    } catch (err) {
      setReplaceError(err instanceof Error ? err.message : 'Failed to replace token');
    } finally {
      setReplacing(false);
    }
  }, [client, editingBotKey, replaceToken, replaceValidatedUsername, bots, loadBots, onBotChange]);

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
            }}
          >
            {bots.map((bot) => (
              <BotRow
                key={bot.botKey}
                username={bot.username ? `@${bot.username}` : bot.botKey.slice(0, 12)}
                personalityName={bot.bind.name}
                personalityAccent="var(--accent)"
                status={bot.tokenConfigured ? 'connected' : 'disconnected'}
                onEdit={() => {
                  setEditingBotKey(bot.botKey);
                  setReplaceToken('');
                  setReplaceValidatedUsername(null);
                  setReplaceValidationError(null);
                  setReplaceError(null);
                }}
                onRemove={() => handleRemove(bot.botKey)}
              />
            ))}
          </div>
        </div>
      )}

      {editingBotKey &&
        (() => {
          const editingBot = bots.find((b) => b.botKey === editingBotKey);
          return (
            <div>
              <div style={microLabel}>REPLACE TOKEN</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
                Replacing token for{' '}
                <strong>
                  {editingBot?.username ? `@${editingBot.username}` : editingBotKey.slice(0, 12)}
                </strong>{' '}
                → {editingBot?.bind.name}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <TokenInput
                    value={replaceToken}
                    onChange={(v) => {
                      setReplaceToken(v);
                      setReplaceValidatedUsername(null);
                      setReplaceValidationError(null);
                    }}
                    placeholder="New bot token"
                    disabled={replaceValidating}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleReplaceValidate}
                  disabled={!replaceToken.trim() || replaceValidating}
                  style={{
                    height: 28,
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    background: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    padding: '0 12px',
                    cursor: !replaceToken.trim() || replaceValidating ? 'not-allowed' : 'pointer',
                    opacity: !replaceToken.trim() || replaceValidating ? 0.5 : 1,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {replaceValidating ? 'Validating...' : 'Validate'}
                </button>
              </div>

              {replaceValidatedUsername && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--success)',
                    marginBottom: 12,
                  }}
                >
                  Bot: @{replaceValidatedUsername} ✓
                </div>
              )}
              {replaceValidationError && (
                <div style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>
                  {replaceValidationError}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setEditingBotKey(null);
                    setReplaceToken('');
                    setReplaceValidatedUsername(null);
                  }}
                  style={{
                    flex: 1,
                    height: 36,
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    background: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleReplace}
                  disabled={!replaceValidatedUsername || replacing}
                  style={{
                    flex: 1,
                    height: 36,
                    borderRadius: 4,
                    border: 'none',
                    backgroundColor:
                      replaceValidatedUsername && !replacing
                        ? 'var(--accent)'
                        : 'var(--bg-elevated)',
                    color: replaceValidatedUsername && !replacing ? '#fff' : 'var(--text-tertiary)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: replaceValidatedUsername && !replacing ? 'pointer' : 'not-allowed',
                  }}
                >
                  {replacing ? 'Replacing...' : 'Replace token'}
                </button>
              </div>
              {replaceError && (
                <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>
                  {replaceError}
                </div>
              )}
            </div>
          );
        })()}

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
