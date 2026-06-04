import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityPage } from '../activity/ActivityPage';
import { ChatPage } from '../chat/ChatPage';
import { useSessionList } from '../chat/useSessionList';
import { CronPage } from '../cron/CronPage';
import { ErrorBoundary } from '../ErrorBoundary';
import { ApiKeysPage } from '../lab/api-keys/ApiKeysPage';
import { BatchPage } from '../lab/batch/BatchPage';
import { KanbanPage } from '../lab/kanban/KanbanPage';
import { MeshPage } from '../lab/mesh/MeshPage';
import { ObservabilityPage } from '../lab/observability/ObservabilityPage';
import { McpPage } from '../mcp/McpPage';
import { MemoryPage } from '../memory/MemoryPage';
import { PersonalitiesPage } from '../personalities/PersonalitiesPage';
import { PlatformsPage } from '../platforms/PlatformsPage';
import { PluginsPage } from '../plugins/PluginsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { SkillsPage } from '../skills/SkillsPage';
import { useAppState } from '../state/AppContext';
import { AppSidebar } from './AppSidebar';
import { CommandPalette } from './CommandPalette';
import { RightDrawer } from './RightDrawer';
import { StatusBar } from './StatusBar';
import { type Toast, ToastContainer } from './ToastContainer';
import { useDrawerStream } from './useDrawerStream';

type ShellRoute =
  | 'chat'
  | 'personalities'
  | 'memory'
  | 'cron'
  | 'activity'
  | 'platforms'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'settings'
  | 'batch-eval'
  | 'kanban'
  | 'observability'
  | 'mesh'
  | 'api-keys';

export function AppShell() {
  const {
    state,
    setPort,
    setAdvancedMode,
    setDesktopUserId,
    setLastTitledSession,
    setActiveSessionId,
  } = useAppState();
  const [route, setRoute] = useState<ShellRoute>('chat');
  const [healthy, setHealthy] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [resolvedPort, setResolvedPort] = useState(3001);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [providerModel, setProviderModel] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const drawerState = useDrawerStream();

  const baseUrl = `http://localhost:${resolvedPort}`;
  const sessionList = useSessionList({ baseUrl, enabled: healthy });
  const sessionListRefresh = sessionList.refresh;

  const client = useMemo(
    () =>
      createEthosClient({ baseUrl: `http://localhost:${resolvedPort}`, fetch: globalThis.fetch }),
    [resolvedPort],
  );

  const pinnedSessions = useMemo(
    () => sessionList.sessions.filter((s) => s.pinned),
    [sessionList.sessions],
  );

  const handleSessionListRefresh = useCallback(() => {
    sessionListRefresh();
  }, [sessionListRefresh]);

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    setRoute('chat');
  }, [setActiveSessionId]);

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      setRoute('chat');
    },
    [setActiveSessionId],
  );

  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      try {
        await client.rpc.sessions.update({ id, title });
        sessionListRefresh();
        if (id === state.activeSessionId) {
          setLastTitledSession({ sessionId: id, title });
        }
      } catch {
        // best-effort
      }
    },
    [client, sessionListRefresh, state.activeSessionId, setLastTitledSession],
  );

  const handleForkSession = useCallback(
    async (id: string) => {
      try {
        const res = await client.rpc.sessions.fork({ id });
        setActiveSessionId(res.session.id);
        sessionListRefresh();
        setRoute('chat');
      } catch {
        // best-effort
      }
    },
    [client, setActiveSessionId, sessionListRefresh],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await client.rpc.sessions.delete({ id });
        if (id === state.activeSessionId) {
          setActiveSessionId(null);
        }
        sessionListRefresh();
      } catch {
        // best-effort
      }
    },
    [client, state.activeSessionId, setActiveSessionId, sessionListRefresh],
  );

  const handlePinSession = useCallback(
    async (id: string) => {
      try {
        await client.rpc.sessions.pin({ id });
        sessionListRefresh();
      } catch {
        // best-effort
      }
    },
    [client, sessionListRefresh],
  );

  const handleUnpinSession = useCallback(
    async (id: string) => {
      try {
        await client.rpc.sessions.unpin({ id });
        sessionListRefresh();
      } catch {
        // best-effort
      }
    },
    [client, sessionListRefresh],
  );

  const handleExportSession = useCallback(
    async (id: string) => {
      try {
        const res = await client.rpc.sessions.export({ id, format: 'markdown' });
        await window.ethos.file.save({ defaultName: res.filename, content: res.content });
      } catch {
        // best-effort
      }
    },
    [client],
  );

  useEffect(() => {
    async function bootstrap() {
      try {
        const enabled = await window.ethos.settings.getAdvancedMode();
        setAdvancedMode(enabled);
      } catch {
        // Keep default false
      }

      let resolvedPort = 3001;
      try {
        resolvedPort = await window.ethos.backend.getPort();
      } catch {
        // fallback to default
      }
      setPort(resolvedPort);
      setResolvedPort(resolvedPort);

      try {
        await window.ethos.backend.start({ port: resolvedPort });
      } catch {
        // Backend may already be running
      }

      const poll = setInterval(async () => {
        try {
          const { healthy: isHealthy } = await window.ethos.health.check({ port: resolvedPort });
          if (isHealthy) {
            clearInterval(poll);
            try {
              const token = await window.ethos.backend.getAuthToken();
              if (token) {
                await fetch(
                  `http://localhost:${resolvedPort}/auth/exchange?t=${encodeURIComponent(token)}`,
                  { credentials: 'include', redirect: 'follow' },
                );
              }
            } catch {
              // best-effort
            }
            try {
              const sdkClient = createEthosClient({
                baseUrl: `http://localhost:${resolvedPort}`,
                fetch: globalThis.fetch,
              });
              const usersRes = await sdkClient.rpc.memory.listUsers({});
              const desktop = usersRes.users.find(
                (u: { platform: string }) => u.platform === 'desktop',
              );
              if (desktop) setDesktopUserId(desktop.userId);
            } catch {
              // best-effort
            }
            setHealthy(true);
            setBackendConnected(true);
          }
        } catch {
          // Not ready yet
        }
      }, 500);

      return () => clearInterval(poll);
    }

    const cleanupPromise = bootstrap();
    return () => {
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [setPort, setAdvancedMode, setDesktopUserId]);

  useEffect(() => {
    if (!healthy) return;
    const check = async () => {
      try {
        const { healthy: ok } = await window.ethos.health.check({ port: resolvedPort });
        setBackendConnected(ok);
      } catch {
        setBackendConnected(false);
      }
    };
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [healthy, resolvedPort]);

  useEffect(() => {
    if (!healthy) return;
    client.rpc.config
      .get({})
      .then((cfg) => {
        setProviderModel(`${cfg.provider} · ${cfg.model}`);
      })
      .catch(() => {});
  }, [healthy, client]);

  useEffect(() => {
    if (!healthy) return;
    const source = new EventSource(`http://localhost:${resolvedPort}/sse/system`, {
      withCredentials: true,
    });
    source.onmessage = (raw) => {
      try {
        const data = JSON.parse(raw.data as string) as {
          type: string;
          sessionId?: string;
          title?: string;
        };
        if (data.type === 'session.titled' && data.sessionId && data.title) {
          setLastTitledSession({ sessionId: data.sessionId, title: data.title });
          sessionListRefresh();
        }
      } catch {
        // ignore
      }
    };
    return () => source.close();
  }, [healthy, resolvedPort, setLastTitledSession, sessionListRefresh]);

  const prevNotifCountRef = useRef(0);
  useEffect(() => {
    const count = drawerState.notifications.length;
    if (count > prevNotifCountRef.current) {
      const newest = drawerState.notifications[0];
      if (newest) {
        const id = `toast-${Date.now()}`;
        setToasts((prev) => [...prev, { id, message: newest.summary, kind: 'info' as const }]);
      }
    }
    prevNotifCountRef.current = count;
  }, [drawerState.notifications]);

  useEffect(() => {
    let lastNarrow = window.innerWidth < 900;
    setSidebarCollapsed(lastNarrow);
    const onResize = () => {
      const narrow = window.innerWidth < 900;
      if (narrow !== lastNarrow) {
        lastNarrow = narrow;
        setSidebarCollapsed(narrow);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [paletteOpen]);

  const handleForkSessionFromChat = useCallback(
    (id?: string) => {
      const targetId = id ?? state.activeSessionId;
      if (targetId) handleForkSession(targetId);
    },
    [state.activeSessionId, handleForkSession],
  );

  const handleNewChatFromPalette = useCallback(() => {
    setRoute('chat');
    setActiveSessionId(null);
  }, [setActiveSessionId]);

  const handleSelectSessionFromPalette = useCallback(
    (id: string) => {
      setRoute('chat');
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  if (!healthy) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-display)',
          fontSize: 14,
        }}
      >
        Starting backend...
      </div>
    );
  }

  return (
    <>
      <div
        style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {!sidebarCollapsed && (
            <AppSidebar
              route={route}
              onNavigate={(r) => setRoute(r as ShellRoute)}
              backendConnected={backendConnected}
              sessions={sessionList.sessions}
              pinnedSessions={pinnedSessions}
              loading={sessionList.loading}
              search={sessionList.search}
              setSearch={sessionList.setSearch}
              activeSessionId={state.activeSessionId}
              onSelectSession={handleSelectSession}
              onNewChat={handleNewChat}
              loadMore={sessionList.loadMore}
              hasMore={sessionList.hasMore}
              onRenameSession={handleRenameSession}
              onForkSession={handleForkSession}
              onExportSession={handleExportSession}
              onDeleteSession={handleDeleteSession}
              onPinSession={handlePinSession}
              onUnpinSession={handleUnpinSession}
            />
          )}
          <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
            {route === 'settings' ? (
              <SettingsPage />
            ) : route === 'chat' ? (
              <ErrorBoundary label="ChatPage">
                <ChatPage
                  onSessionListDirty={handleSessionListRefresh}
                  onForkSession={handleForkSessionFromChat}
                />
              </ErrorBoundary>
            ) : route === 'personalities' ? (
              <ErrorBoundary label="PersonalitiesPage">
                <PersonalitiesPage />
              </ErrorBoundary>
            ) : route === 'mcp' ? (
              <ErrorBoundary label="McpPage">
                <McpPage />
              </ErrorBoundary>
            ) : route === 'plugins' ? (
              <ErrorBoundary label="PluginsPage">
                <PluginsPage />
              </ErrorBoundary>
            ) : route === 'memory' ? (
              <ErrorBoundary label="MemoryPage">
                <MemoryPage />
              </ErrorBoundary>
            ) : route === 'cron' ? (
              <ErrorBoundary label="CronPage">
                <CronPage />
              </ErrorBoundary>
            ) : route === 'platforms' ? (
              <ErrorBoundary label="PlatformsPage">
                <PlatformsPage />
              </ErrorBoundary>
            ) : route === 'skills' ? (
              <ErrorBoundary label="SkillsPage">
                <SkillsPage />
              </ErrorBoundary>
            ) : route === 'batch-eval' ? (
              <ErrorBoundary label="BatchPage">
                <BatchPage />
              </ErrorBoundary>
            ) : route === 'kanban' ? (
              <ErrorBoundary label="KanbanPage">
                <KanbanPage />
              </ErrorBoundary>
            ) : route === 'observability' ? (
              <ErrorBoundary label="ObservabilityPage">
                <ObservabilityPage />
              </ErrorBoundary>
            ) : route === 'mesh' ? (
              <ErrorBoundary label="MeshPage">
                <MeshPage />
              </ErrorBoundary>
            ) : route === 'api-keys' ? (
              <ErrorBoundary label="ApiKeysPage">
                <ApiKeysPage />
              </ErrorBoundary>
            ) : route === 'activity' ? (
              <ErrorBoundary label="ActivityPage">
                <ActivityPage />
              </ErrorBoundary>
            ) : (
              <div>coming soon</div>
            )}
          </div>
          {drawerOpen && (
            <RightDrawer
              state={drawerState}
              onNavigate={(r) => setRoute(r as ShellRoute)}
              onClose={() => setDrawerOpen(false)}
            />
          )}
        </div>
        <StatusBar
          backendConnected={backendConnected}
          providerModel={providerModel}
          onNavigate={(r) => setRoute(r as ShellRoute)}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />
      </div>
      <CommandPalette
        open={paletteOpen}
        port={resolvedPort}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(r) => setRoute(r as ShellRoute)}
        onSelectSession={handleSelectSessionFromPalette}
        onNewChat={handleNewChatFromPalette}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />
      <ToastContainer
        toasts={toasts}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />
    </>
  );
}
