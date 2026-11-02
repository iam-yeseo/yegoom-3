import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { PASSWORD_RULES, validNewPassword } from "../../shared/password";
import { anim, toast } from "../motion";
import "../password.css";

function PasswordField({ label, name, autoComplete, value, onChange, disabled }: {
  label: string; name: string; autoComplete: "current-password" | "new-password";
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return <div className="password-change-field">
    <label htmlFor={id}>{label}</label>
    <span className="password-change-input">
      <input id={id} name={name} type={visible ? "text" : "password"} autoComplete={autoComplete}
        autoCapitalize="none" spellCheck={false} required maxLength={PASSWORD_RULES.maxLength}
        minLength={autoComplete === "new-password" ? PASSWORD_RULES.minLength : undefined}
        value={value} onChange={event => onChange(event.target.value)} disabled={disabled} />
      <button type="button" aria-label={`${label} ${visible ? "숨기기" : "보기"}`} aria-pressed={visible}
        disabled={disabled} onClick={() => setVisible(current => !current)}>{visible ? "숨기기" : "보기"}</button>
    </span>
  </div>;
}

export function PasswordSheet({ username, onClose, onChange }: {
  username: string; onClose: () => void; onChange: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const titleId = useId();
  const helpId = useId();
  useEffect(() => {
    mounted.current = true;
    const node = dialog.current!;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    node.querySelector<HTMLInputElement>('input[name="currentPassword"]')?.focus();
    const entrance = anim(node.querySelector(".password-sheet"), [{ translate: "0 30px", opacity: 0 }, { translate: "0 0", opacity: 1 }], { dur: 240, ease: "out" });
    return () => {
      mounted.current = false;
      entrance?.cancel();
      node.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const close = () => { if (!pending.current) onClose(); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (!currentPassword) { setError("현재 비밀번호를 입력해 주세요."); return; }
    if (!validNewPassword(newPassword)) { setError(`새 비밀번호는 ${PASSWORD_RULES.minLength}~${PASSWORD_RULES.maxLength}자로 입력해 주세요.`); return; }
    if (newPassword === currentPassword) { setError("새 비밀번호는 현재 비밀번호와 다르게 입력해 주세요."); return; }
    if (newPassword !== confirmation) { setError("새 비밀번호 확인이 일치하지 않아요."); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onChange(currentPassword, newPassword);
      if (!mounted.current) return;
      onClose();
      toast("비밀번호를 바꿨어요. 다른 기기에서는 다시 로그인해야 해요.", { wrap: true });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "비밀번호를 바꾸지 못했어요. 다시 시도해 주세요.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <dialog ref={dialog} className="password-dialog" aria-labelledby={titleId} aria-describedby={helpId} aria-busy={busy}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="password-sheet">
      <h2 id={titleId}>비밀번호 변경</h2>
      <p id={helpId}>새 비밀번호는 {PASSWORD_RULES.minLength}~{PASSWORD_RULES.maxLength}자로 입력해 주세요.</p>
      <form onSubmit={event => void submit(event)} noValidate>
        <input type="text" className="password-username" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true" />
        <PasswordField label="현재 비밀번호" name="currentPassword" autoComplete="current-password" value={currentPassword} onChange={setCurrentPassword} disabled={busy} />
        <PasswordField label="새 비밀번호" name="newPassword" autoComplete="new-password" value={newPassword} onChange={setNewPassword} disabled={busy} />
        <PasswordField label="새 비밀번호 확인" name="confirmation" autoComplete="new-password" value={confirmation} onChange={setConfirmation} disabled={busy} />
        {error && <p className="form-message error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "변경 중…" : "변경"}</button>
      </form>
      <p className="password-reset-help">비밀번호를 잊었다면 운영자에게 초기화를 요청하세요</p>
      <button className="text-button password-close" type="button" disabled={busy} onClick={close}>닫기</button>
    </div>
  </dialog>;
}
