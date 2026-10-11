import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export type MobileWorkspaceSheetProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

export function MobileWorkspaceSheet({
  open,
  title,
  onClose,
  children,
}: MobileWorkspaceSheetProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  return (
    <div className="iris-mobile-sheet" data-open={open} aria-hidden={!open}>
      <button
        type="button"
        className="iris-mobile-sheet__backdrop"
        aria-label="Close inspector"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <section
        className="iris-mobile-sheet__surface"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        inert={!open}
      >
        <button
          ref={closeButtonRef}
          type="button"
          className="iris-mobile-sheet__close"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
        {children}
      </section>
    </div>
  );
}
