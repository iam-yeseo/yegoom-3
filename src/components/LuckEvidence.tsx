import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { PhotoMetadata } from "../../shared/types";
import { shrinkPhoto } from "../image-processing";
import { anim } from "../motion";
import "../luck-evidence.css";

function EnlargedPhoto({ photo, label, onClose }: { photo: PhotoMetadata; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    const entrance = anim(node, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }], { dur: 200 });
    return () => {
      entrance?.cancel();
      node.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog className="luck-photo-dialog" ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="luck-photo-dialog-content">
      <div className="luck-photo-dialog-heading"><h2 id={titleId}>{label}</h2><button type="button" aria-label="닫기" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button></div>
      <img key={`${photo.url}:${photo.version}`} src={photo.url} alt={label} />
    </div>
  </dialog>;
}

export function LuckPhotoCard({ photo, label, compact = false }: { photo: PhotoMetadata; label: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className={`luck-photo-card${compact ? " is-compact" : ""}`}>
    <button className="luck-photo-thumbnail" type="button" aria-label={`${label} 크게 보기`} onClick={() => setOpen(true)}>
      <img key={`${photo.url}:${photo.version}`} src={photo.url} alt="" loading="lazy" />
      <span>{label}<span aria-hidden="true">크게 보기 ↗</span></span>
    </button>
    {open && <EnlargedPhoto photo={photo} label={label} onClose={() => setOpen(false)} />}
  </div>;
}

export function LuckPhotoPicker({ photo, disabled, onUpload, onBusyChange }: {
  photo: PhotoMetadata | null;
  disabled: boolean;
  onUpload: (image: string) => Promise<PhotoMetadata>;
  onBusyChange: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  const callbacks = useRef({ onUpload, onBusyChange });
  callbacks.current = { onUpload, onBusyChange };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  async function select(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || disabled || locked.current) return;
    locked.current = true;
    const current = ++generation.current;
    const upload = callbacks.current.onUpload;
    const active = () => mounted.current && current === generation.current;
    setBusy(true); setError(""); setSaved(false);
    callbacks.current.onBusyChange(true);
    try {
      const image = await shrinkPhoto(file);
      if (!active()) return;
      await upload(image);
      if (active()) setSaved(true);
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : "사진을 저장하지 못했어요. 다시 골라 주세요.");
    } finally {
      locked.current = false;
      if (active()) { setBusy(false); callbacks.current.onBusyChange(false); }
    }
  }

  return <section className="luck-photo-picker" aria-label="행운 점수 증거 사진" aria-busy={busy}>
    {photo ? <LuckPhotoCard photo={photo} label="행운 점수 증거 사진" />
      : <div className="luck-photo-empty"><strong>행운 점수 증거 사진</strong><p>점수를 확인할 수 있는 사진을 올려 주세요. 증거 사진이 있어야 점수와 힌트를 저장할 수 있어요.</p></div>}
    <input ref={input} type="file" accept="image/*" aria-label="행운 점수 증거 사진" hidden disabled={disabled || busy} onChange={event => void select(event)} />
    <button className="luck-photo-select" type="button" disabled={disabled || busy} onClick={() => input.current?.click()}>{photo ? "다시 고르기" : "사진 선택"}</button>
    {busy ? <p className="luck-photo-status" role="status">사진을 저장하는 중…</p>
      : saved && <p className="luck-photo-status is-saved" role="status">증거 사진을 저장했어요</p>}
    {error && <p className="form-message error" role="alert">{error}</p>}
  </section>;
}
