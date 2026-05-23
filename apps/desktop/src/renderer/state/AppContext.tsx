import { createContext, type ReactNode, useContext, useState } from 'react';

interface AppState {
  port: number;
  activePersonalityId: string | null;
}

interface AppContextValue {
  state: AppState;
  setPort: (port: number) => void;
  setActivePersonalityId: (id: string | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    port: 3001,
    activePersonalityId: null,
  });

  const setPort = (port: number) => setState((s) => ({ ...s, port }));
  const setActivePersonalityId = (id: string | null) =>
    setState((s) => ({ ...s, activePersonalityId: id }));

  return (
    <AppContext.Provider value={{ state, setPort, setActivePersonalityId }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppState(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}
