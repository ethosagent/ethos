import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { DrawerShell } from '../ui/DrawerShell';
import { DiscordDrawer } from './drawers/DiscordDrawer';
import { EmailDrawer } from './drawers/EmailDrawer';
import { SlackDrawer } from './drawers/SlackDrawer';
import { TelegramDrawer } from './drawers/TelegramDrawer';
import { WhatsAppDrawer } from './drawers/WhatsAppDrawer';
import { PlatformRow } from './PlatformRow';

type PlatformId = 'telegram' | 'slack' | 'discord' | 'email' | 'whatsapp';

interface PlatformState {
  id: PlatformId;
  configured: boolean;
  fields: Record<string, boolean>;
}

const platformMeta: Record<PlatformId, { icon: string; name: string }> = {
  telegram: { icon: '✈', name: 'Telegram' },
  slack: { icon: '#', name: 'Slack' },
  discord: { icon: '🎮', name: 'Discord' },
  email: { icon: '✉', name: 'Email' },
  whatsapp: { icon: '📱', name: 'WhatsApp' },
};

const platformOrder: PlatformId[] = ['telegram', 'slack', 'discord', 'email', 'whatsapp'];

export function PlatformsPage() {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [platforms, setPlatforms] = useState<PlatformState[]>([]);
  const [activeDrawer, setActiveDrawer] = useState<PlatformId | null>(null);
  const [explainerDismissed, setExplainerDismissed] = useState(() => {
    try {
      return localStorage.getItem('ethos:platforms:explainer-dismissed') === 'true';
    } catch {
      return false;
    }
  });

  const reload = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.list({});
      setPlatforms(result.platforms as PlatformState[]);
    } catch {
      // Backend may not support platforms yet
    }
  }, [client]);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 30_000);
    return () => clearInterval(interval);
  }, [reload]);

  const dismissExplainer = useCallback(() => {
    setExplainerDismissed(true);
    try {
      localStorage.setItem('ethos:platforms:explainer-dismissed', 'true');
    } catch {}
  }, []);

  const getStatus = (id: PlatformId) => {
    const p = platforms.find((pl) => pl.id === id);
    if (!p?.configured) {
      return { status: 'not-configured' as const, statusText: 'Not configured', detail: '' };
    }
    return { status: 'connected' as const, statusText: 'Connected', detail: '' };
  };

  return (
    <div style={{ padding: '0 24px' }}>
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Platforms
        </h3>
      </div>

      {!explainerDismissed && (
        <div
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 16px',
            border: '1px solid var(--border-subtle)',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              flex: 1,
              lineHeight: 1.4,
            }}
          >
            Connect messaging apps to your agent. All processing happens on your machine. Keep Ethos
            in the tray to stay online.
          </span>
          <button
            type="button"
            onClick={dismissExplainer}
            style={{
              fontSize: 12,
              color: 'var(--info)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              background: 'none',
              border: 'none',
              padding: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
        }}
      >
        {platformOrder.map((id) => {
          const meta = platformMeta[id];
          const { status, statusText, detail } = getStatus(id);
          return (
            <PlatformRow
              key={id}
              icon={meta.icon}
              name={meta.name}
              detail={detail}
              status={status}
              statusText={statusText}
              onAction={() => setActiveDrawer(id)}
            />
          );
        })}
      </div>

      <DrawerShell
        open={activeDrawer === 'telegram'}
        title="Telegram"
        onClose={() => setActiveDrawer(null)}
      >
        <TelegramDrawer onBotChange={reload} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'slack'}
        title="Slack"
        onClose={() => setActiveDrawer(null)}
      >
        <SlackDrawer onBotChange={reload} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'discord'}
        title="Discord"
        onClose={() => setActiveDrawer(null)}
      >
        <DiscordDrawer onBotChange={reload} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'email'}
        title="Email"
        onClose={() => setActiveDrawer(null)}
      >
        <EmailDrawer onBotChange={reload} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'whatsapp'}
        title="WhatsApp"
        onClose={() => setActiveDrawer(null)}
      >
        <WhatsAppDrawer onBotChange={reload} />
      </DrawerShell>
    </div>
  );
}
