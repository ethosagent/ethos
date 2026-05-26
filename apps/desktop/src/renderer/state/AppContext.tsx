import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

interface AppState {
  port: number;
  activePersonalityId: string | null;
  activeSessionId: string | null;
  advancedMode: boolean;
  desktopUserId: string | null;
  lastTitledSession: { sessionId: string; title: string } | null;
}

interface AppContextValue {
  state: AppState;
  setPort: (port: number) => void;
  setActivePersonalityId: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
  setAdvancedMode: (enabled: boolean) => void;
  setDesktopUserId: (id: string | null) => void;
  setLastTitledSession: (event: { sessionId: string; title: string } | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    port: (typeof window !== 'undefined' && window.ethos?.port) || 3001,
    activePersonalityId: null,
    activeSessionId: null,
    advancedMode: false,
    desktopUserId: null,
    lastTitledSession: null,
  });

  const setPort = useCallback((port: number) => setState((s) => ({ ...s, port })), []);
  const setActivePersonalityId = useCallback(
    (id: string | null) => setState((s) => ({ ...s, activePersonalityId: id })),
    [],
  );
  const setActiveSessionId = useCallback(
    (id: string | null) => setState((s) => ({ ...s, activeSessionId: id })),
    [],
  );
  const setAdvancedMode = useCallback(
    (enabled: boolean) => setState((s) => ({ ...s, advancedMode: enabled })),
    [],
  );
  const setDesktopUserId = useCallback(
    (id: string | null) => setState((s) => ({ ...s, desktopUserId: id })),
    [],
  );
  const setLastTitledSession = useCallback(
    (event: { sessionId: string; title: string } | null) =>
      setState((s) => ({ ...s, lastTitledSession: event })),
    [],
  );

  return (
    <AppContext.Provider
      value={{
        state,
        setPort,
        setActivePersonalityId,
        setActiveSessionId,
        setAdvancedMode,
        setDesktopUserId,
        setLastTitledSession,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppState(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}
