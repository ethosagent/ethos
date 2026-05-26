import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useState } from 'react';
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

type ShellRoute =
  | 'chat'
  | 'personalities'
  | 'memory'
  | 'cron'
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
  const { setPort, setAdvancedMode, setDesktopUserId } = useAppState();
  const [route, setRoute] = useState<ShellRoute>('chat');
  const [healthy, setHealthy] = useState(false);

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
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <AppSidebar route={route} onNavigate={(r) => setRoute(r as ShellRoute)} />
      <div style={{ flex: 1, overflow: 'auto' }}>
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
        ) : null}
      </div>
    </div>
  );
}
