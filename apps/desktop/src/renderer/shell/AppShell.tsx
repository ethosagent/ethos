import { useEffect, useState } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { ChatPage } from '../chat/ChatPage';
import { useAppState } from '../state/AppContext';
import { AppSidebar } from './AppSidebar';

type ShellRoute =
  | 'chat'
  | 'personalities'
  | 'memory'
  | 'cron'
  | 'platforms'
  | 'skills'
  | 'settings'
  | 'batch-eval'
  | 'kanban'
  | 'observability'
  | 'mesh'
  | 'api-keys';

export function AppShell() {
  const { setPort, setAdvancedMode } = useAppState();
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
            setHealthy(true);
            clearInterval(poll);
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
  }, [setPort, setAdvancedMode]);

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
        {route === 'chat' ? (
          <ErrorBoundary label="ChatPage">
            <ChatPage />
          </ErrorBoundary>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-tertiary)',
              fontSize: 14,
            }}
          >
            {route.charAt(0).toUpperCase() + route.slice(1).replace(/-/g, ' ')} — coming soon
          </div>
        )}
      </div>
    </div>
  );
}
