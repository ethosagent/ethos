import { type RefObject, useEffect } from 'react';

// W5 (ux-feedback plan) — focus management for the approval modal (and any
// panel that behaves like one). Scope per the plan: move focus to the panel's
// first control on open, and restore it to whatever had focus when the panel
// closes — so a keyboard user is never left focused on `body` under an
// `alertdialog` they cannot reach.

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * On mount: remember `document.activeElement`, then focus the first focusable
 * control inside `ref` (falling back to the container itself). On unmount:
 * restore focus to the remembered element, when it is still in the document.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = container.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? container).focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref]);
}
