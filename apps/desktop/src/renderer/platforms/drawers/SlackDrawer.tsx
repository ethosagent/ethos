import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { PersonalityBindingRow } from '../../ui/PersonalityBindingRow';
import { BotRow } from '../components/BotRow';
import { TokenInput } from '../components/TokenInput';

interface SlackDrawerProps {
  onBotChange?: () => void;
}

interface SlackBot {
  botKey: string;
  botTokenConfigured: boolean;
  appTokenConfigured: boolean;
  signingSecretConfigured: boolean;
  bind: { type: string; name: string };
}

const microLabelStyle = {
  fontSize: 11,
  fontWeight: 600 as const,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  marginBottom: 8,
};

export function SlackDrawer({ onBotChange }: SlackDrawerProps) {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [bots, setBots] = useState<SlackBot[]>([]);
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.botsListSlack({});
      setBots(result.bots as SlackBot[]);
    } catch {
      // Backend may not support this yet
    }
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  const canConnect =
    botToken.trim().length > 0 &&
    appToken.trim().length > 0 &&
    signingSecret.trim().length > 0 &&
    personalityId !== null &&
    personalityId !== '';

  const handleConnect = useCallback(async () => {
    if (!canConnect || !personalityId) return;
    setConnecting(true);
    setError('');
    try {
      await client.rpc.platforms.botsAddSlack({
        botToken: botToken.trim(),
        appToken: appToken.trim(),
        signingSecret: signingSecret.trim(),
        bind: { type: 'personality', name: personalityId },
      });
      setBotToken('');
      setAppToken('');
      setSigningSecret('');
      setPersonalityId(null);
      await reload();
      onBotChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [canConnect, personalityId, botToken, appToken, signingSecret, client, reload, onBotChange]);

  const handleRemove = useCallback(
    async (botKey: string) => {
      try {
        await client.rpc.platforms.botsRemoveSlack({ botKey });
        await reload();
        onBotChange?.();
      } catch {
        // Best-effort removal
      }
    },
    [client, reload, onBotChange],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {bots.length > 0 && (
        <div>
          <div style={microLabelStyle}>CONNECTED WORKSPACES</div>
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
                status={
                  bot.botTokenConfigured && bot.appTokenConfigured && bot.signingSecretConfigured
                    ? 'connected'
                    : 'disconnected'
                }
                onEdit={() => {}}
                onRemove={() => handleRemove(bot.botKey)}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={microLabelStyle}>ADD SLACK APP</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                marginBottom: 4,
                display: 'block',
              }}
            >
              Bot token
            </div>
            <TokenInput value={botToken} onChange={setBotToken} placeholder="xoxb-..." />
          </div>
          <div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                marginBottom: 4,
                display: 'block',
              }}
            >
              App-level token
            </div>
            <TokenInput value={appToken} onChange={setAppToken} placeholder="xapp-..." />
          </div>
          <div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                marginBottom: 4,
                display: 'block',
              }}
            >
              Signing secret
            </div>
            <TokenInput
              value={signingSecret}
              onChange={setSigningSecret}
              placeholder="Signing secret from Basic Information..."
            />
          </div>

          <PersonalityBindingRow value={personalityId} onChange={setPersonalityId} />

          <div
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: 12,
              marginTop: 16,
              lineHeight: 1.5,
            }}
          >
            Find these values in your Slack app's settings at api.slack.com/apps &rarr; select your
            app &rarr; Basic Information and OAuth &amp; Permissions.
          </div>

          <button
            type="button"
            disabled={!canConnect || connecting}
            onClick={handleConnect}
            style={{
              width: '100%',
              height: 36,
              borderRadius: 4,
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              cursor: canConnect && !connecting ? 'pointer' : 'not-allowed',
              opacity: canConnect && !connecting ? 1 : 0.4,
            }}
          >
            {connecting ? 'Connecting...' : 'Connect'}
          </button>

          {error && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--error)',
                padding: '8px 0',
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>

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
