import { useEffect, useRef, useState, type PointerEvent } from "react";
import { PROFILE_PHOTO } from "../../shared/profile";
import { encodePhoto, loadPhoto, photoCanvas, type DecodedPhoto } from "../image-processing";
import { anim } from "../motion";
import "../profile-photo.css";

type Point = { x: number; y: number };
type Crop = { zoom: number; x: number; y: number };

/** Square viewport, matching the original drag/pinch/anchored-zoom picker. */
export function PhotoPicker({ file, onSave, onClose }: {
  file: File;
  onSave: (photo: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const photo = useRef<DecodedPhoto | null>(null);
  const crop = useRef<Crop>({ zoom: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const saving = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoomValue] = useState(100);
  const [error, setError] = useState("");

  const draw = () => {
    const source = photo.current;
    const node = canvas.current;
    if (!source || !node) return;
    const context = node.getContext("2d");
    if (!context) return;
    const scale = crop.current.zoom / Math.min(source.width, source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    crop.current.x = Math.min(0, Math.max(1 - width, crop.current.x));
    crop.current.y = Math.min(0, Math.max(1 - height, crop.current.y));
    context.fillStyle = "#FFF9EE";
    context.fillRect(0, 0, node.width, node.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source.image, crop.current.x * node.width, crop.current.y * node.height, width * node.width, height * node.height);
  };
  const setZoom = (next: number, anchor: Point = { x: .5, y: .5 }) => {
    const before = crop.current.zoom;
    crop.current.zoom = Math.min(4, Math.max(1, next));
    const ratio = crop.current.zoom / before;
    crop.current.x = anchor.x - (anchor.x - crop.current.x) * ratio;
    crop.current.y = anchor.y - (anchor.y - crop.current.y) * ratio;
    setZoomValue(Math.round(crop.current.zoom * 100));
    draw();
  };
  useEffect(() => {
    const node = dialog.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    const entrance = anim(node, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }], { dur: 200 });
    return () => { entrance?.cancel(); node.close(); document.body.style.overflow = overflow; };
  }, []);
  useEffect(() => {
    let active = true;
    setReady(false);
    void loadPhoto(file).then(source => {
      if (!active) { source.close(); return; }
      photo.current = source;
      const short = Math.min(source.width, source.height);
      crop.current = { zoom: 1, x: (1 - source.width / short) / 2, y: (1 - source.height / short) / 2 };
      draw();
      setReady(true);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "사진을 읽지 못했어요."); });
    return () => { active = false; photo.current?.close(); photo.current = null; pointers.current.clear(); };
  }, [file]);
  useEffect(() => {
    const node = canvas.current!;
    const wheel = (event: WheelEvent) => {
      if (!photo.current || saving.current) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      setZoom(crop.current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  const local = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const release = (event: PointerEvent<HTMLCanvasElement>) => { pointers.current.delete(event.pointerId); };
  const close = () => { if (!saving.current) onClose(); };
  const save = async () => {
    const source = photo.current;
    if (!source || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const { canvas: output, context } = photoCanvas(PROFILE_PHOTO.side, PROFILE_PHOTO.side);
      const scale = crop.current.zoom / Math.min(source.width, source.height);
      context.drawImage(source.image, -crop.current.x / scale, -crop.current.y / scale, 1 / scale, 1 / scale, 0, 0, PROFILE_PHOTO.side, PROFILE_PHOTO.side);
      await onSave(encodePhoto(output, PROFILE_PHOTO.maxBytes));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "사진을 저장하지 못했어요. 다시 시도해 주세요.");
    } finally { saving.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="photo-crop-dialog" aria-label="프로필 사진 자르기" aria-busy={busy} data-notouchfx
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <button className="photo-crop-close" type="button" aria-label="자르기 닫기" disabled={busy} onClick={close}>×</button>
    <h2>정사각형으로 자르기</h2>
    <p>사진을 끌어 옮기고 확대해서<br />넣을 부분을 골라 주세요.</p>
    <canvas ref={canvas} className="photo-crop-canvas" width={PROFILE_PHOTO.side} height={PROFILE_PHOTO.side} aria-label="사진 자르기 영역" tabIndex={0} data-notouchfx
      onPointerDown={event => { if (!ready || busy || (event.pointerType === "mouse" && event.button !== 0)) return; event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, local(event)); }}
      onPointerMove={event => {
        const previous = pointers.current.get(event.pointerId);
        if (!previous || busy) return;
        const before = [...pointers.current.values()];
        const next = local(event);
        pointers.current.set(event.pointerId, next);
        if (pointers.current.size >= 2) {
          const after = [...pointers.current.values()];
          const middle = (points: Point[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
          const spread = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
          const oldCenter = middle(before), center = middle(after), distance = spread(before);
          crop.current.x += center.x - oldCenter.x;
          crop.current.y += center.y - oldCenter.y;
          if (distance > 0) setZoom(crop.current.zoom * spread(after) / distance, center);
          else draw();
        } else { crop.current.x += next.x - previous.x; crop.current.y += next.y - previous.y; draw(); }
      }} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
      onKeyDown={event => {
        if (!ready || busy) return;
        const moves: Record<string, Point> = { ArrowLeft: { x: -.02, y: 0 }, ArrowRight: { x: .02, y: 0 }, ArrowUp: { x: 0, y: -.02 }, ArrowDown: { x: 0, y: .02 } };
        const move = moves[event.key];
        if (move) { event.preventDefault(); crop.current.x += move.x; crop.current.y += move.y; draw(); }
      }} />
    {!ready && !error && <p role="status">사진을 읽는 중…</p>}
    <label className="photo-crop-zoom"><span>확대</span><input aria-label="확대 정도" type="range" min="100" max="400" value={zoom} disabled={!ready || busy} onChange={event => setZoom(Number(event.target.value) / 100)} /><output>{zoom}%</output></label>
    <small className="photo-crop-keyboard">방향키로도 사진을 옮길 수 있어요.</small>
    {error && <p className="form-message error" role="alert">{error}</p>}
    <div className="photo-crop-actions"><button type="button" className="text-button" disabled={busy} onClick={close}>취소</button><button type="button" className="primary-button" disabled={!ready || busy} onClick={() => void save()}>{busy ? "사진 저장 중…" : "이 부분으로 저장"}</button></div>
  </dialog>;
}
