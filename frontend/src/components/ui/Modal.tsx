import React, { useEffect, useRef } from 'react';
import { Button } from './Button';
import { modalFocusDestination } from './modal-focus';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
  initialFocusSelector?: string;
  returnFocus?: HTMLElement | null | (() => HTMLElement | null);
  overlayClassName?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = '580px',
  initialFocusSelector,
  returnFocus,
  overlayClassName = '',
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusableSelector = 'button:not(:disabled):not([aria-disabled="true"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusTimer = window.requestAnimationFrame(() => {
      const preferred = initialFocusSelector === undefined
        ? undefined
        : dialogRef.current?.querySelector<HTMLElement>(initialFocusSelector);
      const first = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? first ?? dialogRef.current)?.focus();
    });
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const destination = modalFocusDestination(activeIndex, focusable.length, e.shiftKey);
      if (destination !== undefined) {
        e.preventDefault();
        focusable[destination]?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      const requestedReturn = typeof returnFocus === 'function' ? returnFocus() : returnFocus;
      const target = requestedReturn?.isConnected === true ? requestedReturn : previouslyFocused;
      if (target?.isConnected === true) target.focus();
    };
  }, [initialFocusSelector, isOpen, returnFocus]);

  if (!isOpen) return null;

  return (
    <div className={`modal-overlay ${overlayClassName}`.trim()} onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-card"
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '对话框'}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {title}
          </div>
          <Button variant="ghost" size="sm" aria-label="关闭对话框" onClick={onClose} style={{ padding: '0 8px' }}>
            ✕
          </Button>
        </div>

        <div className="modal-body">{children}</div>

        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
};
