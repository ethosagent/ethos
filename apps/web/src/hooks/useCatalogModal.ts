import { useEffect, useState } from 'react';
import { useCreateFlag } from './useCreateFlag';

/**
 * State for a page's "+ New …" button that opens the catalog browser modal
 * (plan/phases/unified-catalog.md §5.3). `?create=1` (StageHeader's create
 * action) opens it too when `openOnCreateFlag` is set. `onManual` is the
 * page's manual path (AddMcpModal / npm spec / CreateSkillModal); the modal
 * closes first.
 */
export function useCatalogModal(onManual: () => void, openOnCreateFlag = true) {
  const [open, setOpen] = useState(false);
  const shouldCreate = useCreateFlag();
  useEffect(() => {
    if (shouldCreate && openOnCreateFlag) setOpen(true);
  }, [shouldCreate, openOnCreateFlag]);

  return {
    show: () => setOpen(true),
    modalProps: {
      open,
      onClose: () => setOpen(false),
      onManual: () => {
        setOpen(false);
        onManual();
      },
    },
  };
}
