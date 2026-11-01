import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { clamp, hexToHsv, hsvToHex, INK_PALETTE, normalizeHex, saturationValueAt, type HsvColor, type PaintColor } from "../color";
import { anim } from "../motion";

interface ColorPickerProps {
  value: PaintColor;
  onChange: (color: PaintColor) => void;
  onCommit: (color: PaintColor) => void;
  recentColors: string[];
  onClose: () => void;
  allowAlpha?: boolean;
}

export function ColorPicker({ value, onChange, onCommit, recentColors, onClose, allowAlpha = true }: ColorPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [hsv, setHsv] = useState(() => hexToHsv(value.hex));
  const hsvRef = useRef(hsv);
  const colorRef = useRef(value);
  const emittedHex = useRef(normalizeHex(value.hex));
  const [draft, setDraft] = useState(value.hex);
  const pointer = useRef<{ id: number; element: HTMLDivElement } | null>(null);

  // Preserve exact HSV while the parent echoes a drag value (black/gray cannot retain hue in RGB).
  // An independent controlled color change is converted from RGB, including its saturation/value.
  useEffect(() => {
    colorRef.current = value;
    const hex = normalizeHex(value.hex)!;
    if (hex !== emittedHex.current) {
      emittedHex.current = hex;
      hsvRef.current = hexToHsv(hex);
      setHsv(hsvRef.current);
      setDraft(hex);
    }
  }, [value.hex, value.alpha]);

  function releasePointer() {
    const active = pointer.current;
    pointer.current = null;
    if (active?.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
  }
  useEffect(() => {
    const node = dialog.current!;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    const animation = anim(node.firstElementChild, [{ translate: "0 100%", opacity: 0 }, { translate: "0 0", opacity: 1 }], { dur: 420, ease: "spring" });
    return () => {
      releasePointer();
      animation?.cancel();
      node.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  function change(next: HsvColor, alpha = colorRef.current.alpha, updateDraft = true) {
    hsvRef.current = next;
    setHsv(next);
    const color = { hex: hsvToHex(next), alpha: clamp(alpha) };
    colorRef.current = color;
    emittedHex.current = color.hex;
    if (updateDraft) setDraft(color.hex);
    onChange(color);
    return color;
  }
  function select(hex: string) { onCommit(change(hexToHsv(hex))); }
  function position(event: PointerEvent<HTMLDivElement>) {
    change({ ...hsvRef.current, ...saturationValueAt(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()) });
  }
  function selectionKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? .1 : .01;
    let { s, v } = hsvRef.current;
    if (event.key === "ArrowLeft") s -= step;
    else if (event.key === "ArrowRight") s += step;
    else if (event.key === "ArrowUp") v += step;
    else if (event.key === "ArrowDown") v -= step;
    else return;
    event.preventDefault();
    change({ ...hsvRef.current, s: clamp(s), v: clamp(v) });
  }
  function commitHex() {
    const hex = normalizeHex(draft);
    if (hex) { setDraft(hex); onCommit(change(hexToHsv(hex))); }
    else setDraft(colorRef.current.hex);
  }
  const saturation = Math.round(hsv.s * 100), brightness = Math.round(hsv.v * 100);
  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  return <dialog className="color-picker-dialog" aria-labelledby={titleId} ref={dialog} data-notouchfx
    onCancel={event => { event.preventDefault(); onCommit(colorRef.current); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) { onCommit(colorRef.current); onClose(); } }}>
    <div className="color-picker-sheet">
      <div className="color-picker-heading"><h2 id={titleId}>색상 고르기</h2>
        <button type="button" aria-label="색상 선택 닫기" onClick={() => { onCommit(colorRef.current); onClose(); }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="color-picker-sv" role="slider" tabIndex={0} aria-label="채도와 명도"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={saturation} aria-valuetext={`채도 ${saturation}%, 명도 ${brightness}%`}
        data-saturation={saturation} data-value={brightness} style={{ backgroundColor: hueColor }}
        onPointerDown={event => {
          if (event.button !== 0 || pointer.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = { id: event.pointerId, element: event.currentTarget };
          position(event);
        }}
        onPointerMove={event => { if (pointer.current?.id === event.pointerId) position(event); }}
        onPointerUp={event => { if (pointer.current?.id === event.pointerId) { position(event); releasePointer(); onCommit(colorRef.current); } }}
        onPointerCancel={releasePointer} onLostPointerCapture={releasePointer}
        onKeyDown={selectionKey} onKeyUp={event => { if (event.key.startsWith("Arrow")) onCommit(colorRef.current); }}>
        <span className="color-picker-handle" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value.hex }} />
      </div>
      <div className="color-picker-slider"><label htmlFor={`${titleId}-hue`}>색상</label>
        <input id={`${titleId}-hue`} className="color-picker-hue" type="range" min="0" max="360" value={hsv.h} step="1"
          onChange={event => change({ ...hsvRef.current, h: Number(event.target.value) })}
          onPointerUp={() => onCommit(colorRef.current)} onKeyUp={() => onCommit(colorRef.current)} />
      </div>
      <div className="color-picker-slider"><label htmlFor={`${titleId}-alpha`}>불투명도 <span>{Math.round(value.alpha * 100)}%</span></label>
        <input id={`${titleId}-alpha`} className="color-picker-alpha" type="range" min="0" max="100" step="1" value={Math.round(value.alpha * 100)}
          disabled={!allowAlpha} style={{ "--picked-color": value.hex } as CSSProperties}
          onChange={event => change(hsvRef.current, Number(event.target.value) / 100)}
          onPointerUp={() => onCommit(colorRef.current)} onKeyUp={() => onCommit(colorRef.current)} />
        {!allowAlpha && <small>채우기는 불투명한 색으로 칠해요.</small>}
      </div>
      <div className="color-picker-hex"><span className="color-picker-preview" style={{ background: value.hex, opacity: value.alpha }} aria-hidden="true" />
        <label htmlFor={`${titleId}-hex`}>HEX</label>
        <input id={`${titleId}-hex`} aria-label="HEX 색상" value={draft} spellCheck={false} autoComplete="off" maxLength={7}
          aria-invalid={normalizeHex(draft) === null} onChange={event => {
            setDraft(event.target.value);
            if (/^#?[\da-f]{6}$/i.test(event.target.value)) change(hexToHsv(event.target.value), colorRef.current.alpha, false);
          }} onBlur={commitHex} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </div>
      <div className="color-picker-swatches" role="group" aria-label="자주 쓰는 색">
        {INK_PALETTE.map(([hex, name]) => <button key={hex} type="button" aria-label={`${name} 선택`} aria-pressed={value.hex === hex}
          style={{ background: hex, "--swatch-color": hex } as CSSProperties} onClick={() => select(hex)} />)}
      </div>
      <div className="color-picker-recents"><span>최근 색상</span>
        <div className="color-picker-swatches" role="group" aria-label="최근 색상">
          {recentColors.map(hex => <button key={hex} type="button" aria-label={`최근 색상 ${hex}`} aria-pressed={value.hex === hex}
            style={{ background: hex, "--swatch-color": hex } as CSSProperties} onClick={() => select(hex)} />)}
          {!recentColors.length && <small>고른 색을 여기에 모아 둘게요.</small>}
        </div>
      </div>
    </div>
  </dialog>;
}
