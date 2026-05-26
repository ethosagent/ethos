import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

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
    port: 3001,
    activePersonalityId: null,
    activeSessionId: null,
    advancedMode: false,
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
