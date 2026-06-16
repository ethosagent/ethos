import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

// Hoists the New Session modal's open/close state to the App shell so any
// entry point (sidebar, chat "+" button, command palette) can open the one
// modal that's rendered once near the shell root.

interface NewSessionModalValue {
  open: boolean;
  openNewSessionModal: () => void;
  closeNewSessionModal: () => void;
}

const NewSessionModalContext = createContext<NewSessionModalValue | null>(null);

export function NewSessionModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openNewSessionModal = useCallback(() => setOpen(true), []);
  const closeNewSessionModal = useCallback(() => setOpen(false), []);
  const value = useMemo(
    () => ({ open, openNewSessionModal, closeNewSessionModal }),
    [open, openNewSessionModal, closeNewSessionModal],
  );
  return (
    <NewSessionModalContext.Provider value={value}>{children}</NewSessionModalContext.Provider>
  );
}

export function useNewSessionModal(): NewSessionModalValue {
  const ctx = useContext(NewSessionModalContext);
  if (!ctx) throw new Error('useNewSessionModal must be used within NewSessionModalProvider');
  return ctx;
}
