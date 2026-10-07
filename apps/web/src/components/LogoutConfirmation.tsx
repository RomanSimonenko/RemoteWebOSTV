import { useLayoutEffect, useRef, type RefObject } from 'react';
import { IconLogout } from '@tabler/icons-react';

interface Props { open: boolean; anchor: RefObject<HTMLButtonElement | null>; onClose(): void; onConfirm(): void }

export function LogoutConfirmation({ open, anchor, onClose, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    function position() {
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds || !element) return;
      element.style.top = `${Math.max(16, Math.min(bounds.bottom + 8, window.innerHeight - element.offsetHeight - 16))}px`;
      element.style.right = `${Math.max(16, window.innerWidth - bounds.right)}px`;
    }
    element.showModal();
    position();
    cancel.current?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      element.close();
      if (anchor.current?.isConnected) anchor.current.focus();
    };
  }, [open, anchor]);
  return <dialog ref={dialog} tabIndex={0} className="logout-confirmation" aria-labelledby="logout-title" onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    (document.activeElement === cancel.current ? confirm.current : cancel.current)?.focus();
  }} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <div className="power-confirm-heading"><IconLogout aria-hidden="true" /><h3 id="logout-title">Выйти из приложения?</h3></div>
    <div className="power-confirm-actions"><button ref={cancel} type="button" onClick={onClose}>Отмена</button><button ref={confirm} className="power-confirm-submit" type="button" onClick={onConfirm}>Выйти</button></div>
  </dialog>;
}
