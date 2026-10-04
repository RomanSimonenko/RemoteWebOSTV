import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface Props { open: boolean; onClose(): void; children: ReactNode }

export function SettingsDialog({ open, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      closeButton.current?.focus();
    } else if (!open && element.open) {
      element.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);
  return <dialog ref={dialog} aria-label="Настройки телевизора" className="settings-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="settings-heading"><h2>Настройки телевизора</h2><button ref={closeButton} type="button" aria-label="Закрыть настройки" onClick={onClose}>×</button></div>
    {children}
  </dialog>;
}
