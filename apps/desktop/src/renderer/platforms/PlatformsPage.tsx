import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { DrawerShell } from '../ui/DrawerShell';
import { StatusDot } from '../ui/StatusDot';
import { DiscordDrawer } from './drawers/DiscordDrawer';
import { EmailDrawer } from './drawers/EmailDrawer';
import { SlackDrawer } from './drawers/SlackDrawer';
import { TelegramDrawer } from './drawers/TelegramDrawer';
import { WhatsAppDrawer } from './drawers/WhatsAppDrawer';

type PlatformId = 'telegram' | 'slack' | 'discord' | 'email' | 'whatsapp';

interface PlatformState {
  id: PlatformId;
  configured: boolean;
  fields: Record<string, boolean>;
}

interface TelegramBot {
  botKey: string;
  tokenConfigured: boolean;
  username?: string;
  bind: { type: 'personality' | 'team'; name: string };
}

interface SlackBot {
  botKey: string;
  botTokenConfigured: boolean;
  appTokenConfigured: boolean;
  signingSecretConfigured: boolean;
  bind: { type: string; name: string };
}

interface WhatsAppBot {
  botKey: string;
  paired: boolean;
  phoneNumber?: string;
  bind?: { type: string; name: string };
}

const platformMeta: Record<PlatformId, { icon: string; name: string; description: string }> = {
  telegram: {
    icon: '✈',
    name: 'Telegram',
    description: 'Connect your Telegram bots to receive and send messages through Ethos.',
  },
  slack: {
    icon: '#',
    name: 'Slack',
    description: 'Connect your Slack workspace to receive and send messages through Ethos.',
  },
  discord: {
    icon: '🎮',
    name: 'Discord',
    description: 'Connect your Discord server to receive and send messages through Ethos.',
  },
  email: {
    icon: '✉',
    name: 'Email',
    description: 'Configure SMTP/IMAP to receive and send email messages through Ethos.',
  },
  whatsapp: {
    icon: '📱',
    name: 'WhatsApp',
    description: 'Connect your WhatsApp number to receive and send messages through Ethos.',
  },
};

const platformOrder: PlatformId[] = ['telegram', 'slack', 'discord', 'email', 'whatsapp'];

// ---------------------------------------------------------------------------
// Label prefix badge
// ---------------------------------------------------------------------------

function LabelPrefixBadge({ type }: { type: string }) {
  const isPersonality = type === 'personality';
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        textTransform: 'uppercase',
        background: isPersonality ? 'rgba(74,158,255,0.12)' : 'rgba(245,158,11,0.12)',
        color: isPersonality ? 'var(--blue)' : 'var(--amber)',
        padding: '1px 5px',
        borderRadius: 3,
        lineHeight: 1.4,
      }}
    >
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Platform stub (unconnected)
// ---------------------------------------------------------------------------

function PlatformStub({
  icon,
  name,
  description,
  onConnect,
}: {
  icon: string;
  name: string;
  description: string;
  onConnect: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 300,
        gap: 12,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          backgroundColor: 'var(--bg-elevated)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          textAlign: 'center',
          maxWidth: 300,
        }}
      >
        {description}
      </div>
      <button
        type="button"
        onClick={onConnect}
        style={{
          fontSize: 12,
          padding: '8px 14px',
          borderRadius: 4,
          border: 'none',
          backgroundColor: 'var(--accent)',
          color: '#fff',
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        Connect {name}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token preview
// ---------------------------------------------------------------------------

function TokenPreview({ botKey }: { botKey: string }) {
  const lastFour = botKey.length >= 4 ? botKey.slice(-4) : botKey;
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--text-secondary)',
      }}
    >
      {'••••••'}
      {lastFour}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Bot table header style
// ---------------------------------------------------------------------------

const thStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
  textAlign: 'left',
  padding: '6px 12px',
  borderBottom: '1px solid var(--border-subtle)',
};

// ---------------------------------------------------------------------------
// Telegram table (configured state)
// ---------------------------------------------------------------------------

function TelegramTable({ bots, onAdd }: { bots: TelegramBot[]; onAdd: () => void }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {bots.length} bot{bots.length !== 1 ? 's' : ''} configured
        </span>
        <button
          type="button"
          onClick={onAdd}
          style={{
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 4,
            border: 'none',
            backgroundColor: 'var(--accent)',
            color: '#fff',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Add Telegram bot
        </button>
      </div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 160 }}>TOKEN PREVIEW</th>
            <th style={thStyle}>PERSONALITY / TEAM</th>
            <th style={{ ...thStyle, width: 100 }}>STATUS</th>
            <th style={{ ...thStyle, width: 80 }}>{''}</th>
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => (
            <BotTableRow
              key={bot.botKey}
              tokenPreview={<TokenPreview botKey={bot.botKey} />}
              bindType={bot.bind.type}
              bindName={bot.bind.name}
              status={bot.tokenConfigured ? 'connected' : 'disconnected'}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slack table (configured state)
// ---------------------------------------------------------------------------

function SlackTable({ bots, onAdd }: { bots: SlackBot[]; onAdd: () => void }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {bots.length} app{bots.length !== 1 ? 's' : ''} configured
        </span>
        <button
          type="button"
          onClick={onAdd}
          style={{
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 4,
            border: 'none',
            backgroundColor: 'var(--accent)',
            color: '#fff',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Add Slack app
        </button>
      </div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 160 }}>TOKEN PREVIEW</th>
            <th style={thStyle}>PERSONALITY / TEAM</th>
            <th style={{ ...thStyle, width: 100 }}>STATUS</th>
            <th style={{ ...thStyle, width: 80 }}>{''}</th>
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => {
            const allConfigured =
              bot.botTokenConfigured && bot.appTokenConfigured && bot.signingSecretConfigured;
            return (
              <BotTableRow
                key={bot.botKey}
                tokenPreview={<TokenPreview botKey={bot.botKey} />}
                bindType={bot.bind.type}
                bindName={bot.bind.name}
                status={allConfigured ? 'connected' : 'disconnected'}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp table (configured state)
// ---------------------------------------------------------------------------

function WhatsAppTable({ bots, onAdd }: { bots: WhatsAppBot[]; onAdd: () => void }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {bots.length} bot{bots.length !== 1 ? 's' : ''} configured
        </span>
        <button
          type="button"
          onClick={onAdd}
          style={{
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 4,
            border: 'none',
            backgroundColor: 'var(--accent)',
            color: '#fff',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Enable WhatsApp
        </button>
      </div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 160 }}>BOT ID</th>
            <th style={thStyle}>PERSONALITY / TEAM</th>
            <th style={{ ...thStyle, width: 100 }}>STATUS</th>
            <th style={{ ...thStyle, width: 80 }}>{''}</th>
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => (
            <BotTableRow
              key={bot.botKey}
              tokenPreview={
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  {bot.botKey}
                </span>
              }
              bindType={bot.bind?.type ?? 'personality'}
              bindName={bot.bind?.name ?? '—'}
              status={bot.paired ? 'connected' : 'disconnected'}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bot table row
// ---------------------------------------------------------------------------

function BotTableRow({
  tokenPreview,
  bindType,
  bindName,
  status,
}: {
  tokenPreview: React.ReactNode;
  bindType: string;
  bindName: string;
  status: 'connected' | 'disconnected';
}) {
  const statusColor = status === 'connected' ? 'var(--success)' : 'var(--text-tertiary)';
  const statusLabel = status === 'connected' ? 'Connected' : 'Disconnected';

  return (
    <tr
      style={{ height: 40 }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.02)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <td
        style={{
          padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
          width: 160,
        }}
      >
        {tokenPreview}
      </td>
      <td
        style={{
          padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <LabelPrefixBadge type={bindType} />
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{bindName}</span>
        </span>
      </td>
      <td
        style={{
          padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
          width: 100,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <StatusDot color={statusColor} />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{statusLabel}</span>
        </span>
      </td>
      <td
        style={{
          padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
          width: 80,
        }}
      />
    </tr>
  );
}

// ---------------------------------------------------------------------------
// PlatformsPage
// ---------------------------------------------------------------------------

export function PlatformsPage() {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [platforms, setPlatforms] = useState<PlatformState[]>([]);
  const [activeTab, setActiveTab] = useState<PlatformId>('telegram');
  const [activeDrawer, setActiveDrawer] = useState<PlatformId | null>(null);

  // Multi-bot data
  const [telegramBots, setTelegramBots] = useState<TelegramBot[]>([]);
  const [slackBots, setSlackBots] = useState<SlackBot[]>([]);
  const [whatsappBots, setWhatsAppBots] = useState<WhatsAppBot[]>([]);

  const reload = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.list({});
      setPlatforms(result.platforms as PlatformState[]);
    } catch {
      // Backend may not support platforms yet
    }
  }, [client]);

  const loadTelegramBots = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.botsListTelegram({});
      setTelegramBots(result.bots as TelegramBot[]);
    } catch {
      // Backend may not support this yet
    }
  }, [client]);

  const loadSlackBots = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.botsListSlack({});
      setSlackBots(result.bots as SlackBot[]);
    } catch {
      // Backend may not support this yet
    }
  }, [client]);

  const loadWhatsAppBots = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.botsListWhatsApp({});
      setWhatsAppBots(result.bots as WhatsAppBot[]);
    } catch {
      // Backend may not support this yet
    }
  }, [client]);

  const reloadAll = useCallback(async () => {
    await Promise.all([reload(), loadTelegramBots(), loadSlackBots(), loadWhatsAppBots()]);
  }, [reload, loadTelegramBots, loadSlackBots, loadWhatsAppBots]);

  useEffect(() => {
    reloadAll();
    const interval = setInterval(reloadAll, 30_000);
    return () => clearInterval(interval);
  }, [reloadAll]);

  const isConfigured = (id: PlatformId): boolean => {
    if (id === 'telegram') return telegramBots.length > 0;
    if (id === 'slack') return slackBots.length > 0;
    if (id === 'whatsapp') return whatsappBots.length > 0;
    const p = platforms.find((pl) => pl.id === id);
    return p?.configured ?? false;
  };

  const renderTabContent = (tabId: PlatformId) => {
    const meta = platformMeta[tabId];
    const configured = isConfigured(tabId);

    if (!configured) {
      return (
        <PlatformStub
          icon={meta.icon}
          name={meta.name}
          description={meta.description}
          onConnect={() => setActiveDrawer(tabId)}
        />
      );
    }

    if (tabId === 'telegram') {
      return <TelegramTable bots={telegramBots} onAdd={() => setActiveDrawer('telegram')} />;
    }
    if (tabId === 'slack') {
      return <SlackTable bots={slackBots} onAdd={() => setActiveDrawer('slack')} />;
    }
    if (tabId === 'whatsapp') {
      return <WhatsAppTable bots={whatsappBots} onAdd={() => setActiveDrawer('whatsapp')} />;
    }

    // Legacy (discord, email): show a simple "Manage" view
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 200,
          gap: 12,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <StatusDot color="var(--success)" />
          <span
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
            }}
          >
            Connected
          </span>
        </span>
        <button
          type="button"
          onClick={() => setActiveDrawer(tabId)}
          style={{
            fontSize: 12,
            padding: '8px 14px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            background: 'none',
            color: 'var(--text-primary)',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Manage {meta.name}
        </button>
      </div>
    );
  };

  return (
    <div style={{ padding: '0 24px' }}>
      {/* Page header */}
      <div style={{ marginBottom: 4 }}>
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
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginTop: 2,
          }}
        >
          Configure messaging channels
        </div>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 16,
        }}
      >
        {platformOrder.map((id) => {
          const meta = platformMeta[id];
          const isActive = id === activeTab;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                padding: '8px 12px',
                fontSize: 13,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: isActive ? 500 : 400,
                transition: `color var(--motion-fast) var(--ease)`,
              }}
            >
              {meta.name}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>{renderTabContent(activeTab)}</div>

      {/* Drawers */}
      <DrawerShell
        open={activeDrawer === 'telegram'}
        title="Telegram"
        onClose={() => setActiveDrawer(null)}
      >
        <TelegramDrawer onBotChange={reloadAll} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'slack'}
        title="Slack"
        onClose={() => setActiveDrawer(null)}
      >
        <SlackDrawer onBotChange={reloadAll} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'discord'}
        title="Discord"
        onClose={() => setActiveDrawer(null)}
      >
        <DiscordDrawer onBotChange={reloadAll} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'email'}
        title="Email"
        onClose={() => setActiveDrawer(null)}
      >
        <EmailDrawer onBotChange={reloadAll} />
      </DrawerShell>
      <DrawerShell
        open={activeDrawer === 'whatsapp'}
        title="WhatsApp"
        onClose={() => setActiveDrawer(null)}
      >
        <WhatsAppDrawer onBotChange={reloadAll} />
      </DrawerShell>
    </div>
  );
}
