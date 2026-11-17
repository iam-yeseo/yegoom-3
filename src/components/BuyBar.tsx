import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openSheet } from "../motion";

/** The use/buy button of a shop item, pinned to the bottom of the viewport so
 * it stays in reach however far the page is scrolled. It is rendered outside
 * the screen container: a screen transition transforms that container, and a
 * transformed ancestor would un-pin a fixed child. */
export function BuyBar({ children, label }: { children: ReactNode; label: string }) {
  return createPortal(<div className="shop-buy-bar" role="group" aria-label={label}>
    <div className="shop-purchase-actions">{children}</div>
  </div>, document.body);
}

/** A centered result modal (draw numbers, scratch result, evolution result). */
export function ResultDialog({ label, className = "", onClose, children }: { label: string; className?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => openSheet(dialog.current!), []);
  return <dialog ref={dialog} className={`launch-dialog result-dialog ${className}`} aria-label={label}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}
