import { useEffect, useState } from 'react';
import { OnboardingShell } from './onboarding/OnboardingShell';
import { AppProvider } from './state/AppContext';

declare global {
  interface Window {
    ethos: {
      platform: string;
      onboarding: {
        state: () => Promise<{ configured: boolean }>;
        validateProvider: (req: {
          provider: string;
          apiKey: string;
          baseUrl?: string;
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
      health: {
        check: (req: { port: number }) => Promise<{ healthy: boolean }>;
      };
      theme: {
        get: () => Promise<'dark' | 'light'>;
      };
    };
  }
}

type AppRoute = 'loading' | 'onboarding' | 'chat';

export function App() {
  const [route, setRoute] = useState<AppRoute>('loading');

  useEffect(() => {
    async function init() {
      const theme = await window.ethos.theme.get();
      document.documentElement.setAttribute('data-theme', theme);

      const { configured } = await window.ethos.onboarding.state();
      setRoute(configured ? 'chat' : 'onboarding');
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--text-primary)',
        }}
      >
        <p>Chat coming in Phase 2</p>
      </div>
    </AppProvider>
  );
}
