import { createContext, type ReactNode, useContext, useState } from 'react';

interface AppState {
  port: number;
  activePersonalityId: string | null;
  activeSessionId: string | null;
  advancedMode: boolean;
}

interface AppContextValue {
  state: AppState;
  setPort: (port: number) => void;
  setActivePersonalityId: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
  setAdvancedMode: (enabled: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    port: (typeof window !== 'undefined' && window.ethos?.port) || 3001,
    activePersonalityId: null,
    activeSessionId: null,
    advancedMode: false,
  });

  const setPort = (port: number) => setState((s) => ({ ...s, port }));
  const setActivePersonalityId = (id: string | null) =>
    setState((s) => ({ ...s, activePersonalityId: id }));
  const setActiveSessionId = (id: string | null) =>
    setState((s) => ({ ...s, activeSessionId: id }));
  const setAdvancedMode = (enabled: boolean) => setState((s) => ({ ...s, advancedMode: enabled }));

  return (
    <AppContext.Provider
      value={{ state, setPort, setActivePersonalityId, setActiveSessionId, setAdvancedMode }}
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
