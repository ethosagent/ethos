import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityPage } from '../activity/ActivityPage';
import { ChatPage } from '../chat/ChatPage';
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
import { SettingsPage } from '../settings/SettingsPage';
import { SkillsPage } from '../skills/SkillsPage';
import { useAppState } from '../state/AppContext';
import { AppSidebar } from './AppSidebar';
import { CommandPalette } from './CommandPalette';
import { RightDrawer } from './RightDrawer';
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
  | 'settings'
  | 'batch-eval'
  | 'kanban'
  | 'observability'
  | 'mesh'
  | 'api-keys';

export function AppShell() {
  const { setPort, setAdvancedMode, setDesktopUserId, setLastTitledSession, setActiveSessionId } =
    useAppState();
  const [route, setRoute] = useState<ShellRoute>('chat');
  const [healthy, setHealthy] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [resolvedPort, setResolvedPort] = useState(3001);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Must be called unconditionally (React hooks rule). Returns empty state when
  // no activeSessionId is set.
  const drawerState = useDrawerStream();

  useEffect(() => {
    async function bootstrap() {
      // Load advanced mode from persisted settings
      try {
        const enabled = await window.ethos.settings.getAdvancedMode();
        setAdvancedMode(enabled);
      } catch {
        // Keep default false
      }

      // Resolve port via IPC
      let resolvedPort = 3001;
      try {
        resolvedPort = await window.ethos.backend.getPort();
      } catch {
        // fallback to default
      }
      setPort(resolvedPort);
      setResolvedPort(resolvedPort);

      // Start the backend
      try {
        await window.ethos.backend.start({ port: resolvedPort });
      } catch {
        // Backend may already be running
      }

      // Poll health until healthy
      const poll = setInterval(async () => {
        try {
          const { healthy: isHealthy } = await window.ethos.health.check({ port: resolvedPort });
          if (isHealthy) {
            clearInterval(poll);
            // Exchange the backend auth token to set the ethos_auth cookie.
            // Without this, all /rpc/* and /sse/* calls fail with 401.
            try {
              const token = await window.ethos.backend.getAuthToken();
              if (token) {
                await fetch(
                  `http://localhost:${resolvedPort}/auth/exchange?t=${encodeURIComponent(token)}`,
                  { credentials: 'include', redirect: 'follow' },
                );
              }
            } catch {
              // best-effort — existing cookie may still be valid
            }
            // Resolve the desktop user's internal userId (seeded by serve.ts on startup).
            // Used by ChatPage (to scope USER.md writes) and MemoryPage (user dropdown).
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
        }
      } catch {
        // ignore
      }
    };
    return () => source.close();
  }, [healthy, resolvedPort, setLastTitledSession]);

  // Toast generation: fire a toast for each new notification that arrives in the drawer.
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

  // ⌘K / Ctrl+K global handler
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
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <AppSidebar
          route={route}
          onNavigate={(r) => setRoute(r as ShellRoute)}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          backendConnected={backendConnected}
        />
        <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
          {route === 'settings' ? (
            <SettingsPage />
          ) : route === 'chat' ? (
            <ErrorBoundary label="ChatPage">
              <ChatPage />
            </ErrorBoundary>
          ) : route === 'personalities' ? (
            <ErrorBoundary label="PersonalitiesPage">
              <PersonalitiesPage />
            </ErrorBoundary>
          ) : route === 'mcp' ? (
            <ErrorBoundary label="McpPage">
              <McpPage />
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
          ) : null}
        </div>
        {drawerOpen && (
          <RightDrawer
            state={drawerState}
            onNavigate={(r) => setRoute(r as ShellRoute)}
            onClose={() => setDrawerOpen(false)}
          />
        )}
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
