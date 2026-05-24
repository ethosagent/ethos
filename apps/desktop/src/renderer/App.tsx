import { useEffect, useState } from 'react';
import type { EthosApi } from '../main/preload';
import { ErrorBoundary } from './ErrorBoundary';
import { OnboardingShell } from './onboarding/OnboardingShell';
import { AppShell } from './shell/AppShell';
import { AppProvider } from './state/AppContext';

declare global {
  interface Window {
    ethos: EthosApi;
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
