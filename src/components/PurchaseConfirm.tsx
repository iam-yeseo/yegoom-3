import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openSheet } from "../motion";

/** What the "정말 살까요?" sheet shows before a shop purchase. */
export interface PurchaseQuestion {
  title: string;
  /** What is spent, e.g. "골드 100G" or "이용권 1장". */
  cost: string;
  detail?: ReactNode;
  confirmLabel?: string;
}
function Sheet({ question, onAnswer }: { question: PurchaseQuestion; onAnswer: (yes: boolean) => void }) {
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (sheet.current) return openSheet(sheet.current); }, []);
  return (
    <dialog className="kuji-modal" ref={sheet} aria-label="구매 확인"
      onCancel={(event) => { event.preventDefault(); onAnswer(false); }}
      onClick={(event) => { if (event.target === event.currentTarget) onAnswer(false); }}>
      <div className="kuji-sheet purchase-confirm">
        <strong>{question.title}</strong>
        <p className="purchase-confirm-cost">{question.cost}</p>
        {question.detail && <p className="purchase-confirm-detail">{question.detail}</p>}
        <div className="sheet-actions">
          <button type="button" className="secondary-button cancel-button" onClick={() => onAnswer(false)}>취소</button>
          <button type="button" className="primary-button" autoFocus onClick={() => onAnswer(true)}>{question.confirmLabel ?? "구매하기"}</button>
        </div>
      </div>
    </dialog>
  );
}
/** `const [sheet, ask] = usePurchaseConfirm()`: render `sheet`, and
 * `await ask({...})` resolves true only when the player confirms. */
export function usePurchaseConfirm(): [ReactNode, (question: PurchaseQuestion) => Promise<boolean>] {
  const [open, setOpen] = useState<{ question: PurchaseQuestion; resolve: (yes: boolean) => void } | null>(null);
  const ask = useCallback((question: PurchaseQuestion) => new Promise<boolean>(resolve => setOpen({ question, resolve })), []);
  useEffect(() => () => open?.resolve(false), [open]);
  const element = open ? <Sheet key={open.question.title + open.question.cost} question={open.question} onAnswer={(yes) => { open.resolve(yes); setOpen(null); }} /> : null;
  return [element, ask];
}
