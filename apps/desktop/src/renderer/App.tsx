import { useEffect, useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { OnboardingShell } from './onboarding/OnboardingShell';
import { AppShell } from './shell/AppShell';
import { AppProvider } from './state/AppContext';

declare global {
  interface Window {
    ethos: {
      platform: string;
      onboarding: {
        state: () => Promise<{ configured: boolean }>;
        validateProvider: (req: {
          provider: 'anthropic' | 'openai' | 'openrouter' | 'azure';
          apiKey: string;
          baseUrl?: string;
          model?: string;
        }) => Promise<unknown>;
        complete: (req: {
          provider: string;
          model: string;
          apiKey: string;
          personalityId: string;
        }) => Promise<{ success: boolean }>;
      };
      personalities: {
        list: () => Promise<
          Array<{
            id: string;
            name: string;
            description: string;
            accent: string;
            isBuiltin: boolean;
          }>
        >;
      };
      backend: {
        getPort: () => Promise<number>;
        start: (req: { port: number }) => Promise<{ started: boolean }>;
      };
      health: {
        check: (req: { port: number }) => Promise<{ healthy: boolean }>;
      };
      theme: {
        get: () => Promise<'dark' | 'light'>;
      };
      settings: {
        getAdvancedMode: () => Promise<boolean>;
        setAdvancedMode: (req: { enabled: boolean }) => Promise<{ ok: boolean }>;
      };
    };
  }
}

type AppRoute = 'loading' | 'onboarding' | 'chat';

export function App() {
  const [route, setRoute] = useState<AppRoute>('loading');

  useEffect(() => {
    async function init() {
      try {
        const theme = await window.ethos.theme.get();
        document.documentElement.setAttribute('data-theme', theme);
        const { configured } = await window.ethos.onboarding.state();
        setRoute(configured ? 'chat' : 'onboarding');
      } catch (err) {
        console.error('[App] init failed — preload not ready?', err);
        setRoute('onboarding');
      }
    }
    init();
  }, []);

  if (route === 'loading') return null;
  if (route === 'onboarding') {
    return (
      <AppProvider>
        <OnboardingShell onComplete={() => setRoute('chat')} />
      </AppProvider>
    );
  }
  return (
    <AppProvider>
      <ErrorBoundary label="AppShell">
        <AppShell />
      </ErrorBoundary>
    </AppProvider>
  );
}
