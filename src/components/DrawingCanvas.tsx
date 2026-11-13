import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { CATCHMIND_RULES } from "../../shared/balance";
import { clamp, hexToRgb, rememberColor, type PaintColor } from "../color";
import { CANVAS_BACKGROUND, floodFill } from "../drawing";
import { ColorPicker } from "./ColorPicker";

type Tool = "pen" | "eraser" | "fill";
type Point = { x: number; y: number };
type SnapshotImage = ImageBitmap | HTMLCanvasElement;
interface Snapshot { image: Promise<SnapshotImage>; hasDrawing: boolean }
interface Stroke {
  pointerId: number; pending: Point[]; last: Point; cursor: Point; started: boolean;
  tool: "pen" | "eraser"; color: PaintColor; width: number;
}
interface DrawingCanvasProps {
  disabled?: boolean;
  publishing?: boolean;
  /** Keeps drawing open but holds the publish button, explaining why. */
  blockedReason?: string;
  onPublish: (image: string) => Promise<void>;
}

function ToolIcon({ tool }: { tool: Tool }) {
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {tool === "pen" && <><path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-4-4L5 15l-1 5Z" /><path d="m5 15 4 4" /></>}
    {tool === "eraser" && <><path d="m4 12 8-8a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8H8l-4-5a2 2 0 0 1 0-3Z" /><path d="m8 8 9 9M12 20h9" /></>}
    {tool === "fill" && <><path d="m8 3 9 9-7 7a2 2 0 0 1-3 0l-4-4a2 2 0 0 1 0-3l7-7M4 12h12" /><path d="M20 14s-2 3-2 4a2 2 0 0 0 4 0c0-1-2-4-2-4Z" /></>}
  </svg>;
}

function imageBytes(url: string) {
  const base64 = url.slice(url.indexOf(",") + 1);
  return base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

function exportImage(canvas: HTMLCanvasElement): string {
  const output = document.createElement("canvas");
  for (const scale of [1, .8, .6, .5]) {
    output.width = output.height = Math.round(canvas.width * scale);
    const context = output.getContext("2d")!;
    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(canvas, 0, 0, output.width, output.height);
    const png = output.toDataURL("image/png");
    if (imageBytes(png) <= CATCHMIND_RULES.maxImageBytes) return png;
    for (const quality of [.9, .75, .6]) {
      const webp = output.toDataURL("image/webp", quality);
      if (imageBytes(webp) <= CATCHMIND_RULES.maxImageBytes) return webp;
    }
  }
  throw new Error("그림 용량이 커서 올리지 못했어요. 조금 지운 뒤 다시 시도해 주세요.");
}

export const DrawingCanvas = memo(function DrawingCanvas({ disabled = false, publishing = false, blockedReason, onPublish }: DrawingCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const fillSurface = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<number | null>(null);
  const history = useRef<Snapshot[]>([]);
  const stroke = useRef<Stroke | null>(null);
  const [historyLength, setHistoryLength] = useState(0);
  const [hasDrawing, setHasDrawing] = useState(false);
  const drawingPresent = useRef(false);
  const [color, setColor] = useState<PaintColor>({ hex: "#5E6A8A", alpha: 1 });
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [size, setSize] = useState(1);
  const [tool, setTool] = useState<Tool>("pen");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoration = useRef(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const busy = disabled || publishing || sending || restoring;

  function remember(selected: PaintColor) { setRecentColors(previous => rememberColor(previous, selected.hex)); }
  function drawingChanged(value: boolean) { drawingPresent.current = value; setHasDrawing(value); }
  function point(event: { clientX: number; clientY: number }): Point {
    const node = canvas.current!, rect = node.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width) * node.width, y: clamp((event.clientY - rect.top) / rect.height) * node.height };
  }
  function snapshot(): Snapshot {
    const node = canvas.current!;
    let image: Promise<SnapshotImage>;
    if (typeof createImageBitmap === "function") {
      // Capture the current pixels before drawing, without synchronously copying
      // a newly allocated canvas on the pointerdown task.
      image = createImageBitmap(node);
    } else {
      const copy = document.createElement("canvas");
      copy.width = node.width; copy.height = node.height;
      copy.getContext("2d")!.drawImage(node, 0, 0);
      image = Promise.resolve(copy);
    }
    // Keep a rejected allocation handled until its undo/eviction is processed.
    void image.catch(() => {});
    return { image, hasDrawing: drawingPresent.current };
  }
  function release(previous: Snapshot) {
    void previous.image.then(image => {
      if ("close" in image) image.close();
      else image.width = image.height = 0;
    }, () => {});
  }
  function save(previous: Snapshot) {
    if (history.current.length === 10) release(history.current.shift()!);
    history.current.push(previous);
    setHistoryLength(history.current.length);
  }
  function renderStroke() {
    const current = stroke.current, context = overlay.current?.getContext("2d");
    if (!current || !context) return;
    if (!current.started) {
      context.beginPath();
      context.arc(current.last.x, current.last.y, current.width / 2, 0, Math.PI * 2);
      context.fill();
      current.started = true;
    }
    if (!current.pending.length) return;
    context.beginPath();
    context.moveTo(current.cursor.x, current.cursor.y);
    // Consume only new samples. Earlier segments remain on the opaque overlay.
    for (const next of current.pending) {
      const previous = current.last;
      const middle = { x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 };
      context.quadraticCurveTo(previous.x, previous.y, middle.x, middle.y);
      current.last = next;
      current.cursor = middle;
    }
    context.stroke();
    current.pending.length = 0;
  }
  function scheduleStroke() {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; renderStroke(); });
  }
  function stop() {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    const current = stroke.current, node = canvas.current, layer = overlay.current;
    if (!current) return;
    if (node && layer) {
      // Include the final coalesced samples even if pointerup precedes this frame.
      renderStroke();
      const ink = layer.getContext("2d")!;
      ink.beginPath();
      ink.moveTo(current.cursor.x, current.cursor.y);
      ink.lineTo(current.last.x, current.last.y);
      ink.stroke();
      const context = node.getContext("2d")!;
      context.save();
      // Alpha is applied once to the complete stroke, including intersections.
      context.globalAlpha = current.tool === "pen" ? current.color.alpha : 1;
      context.drawImage(layer, 0, 0);
      context.restore();
      ink.clearRect(0, 0, layer.width, layer.height);
    }
    stroke.current = null;
    if (node?.hasPointerCapture(current.pointerId)) node.releasePointerCapture(current.pointerId);
  }
  useLayoutEffect(() => {
    // Published drawings always have this opaque background. Avoid an extra
    // alpha/compositor surface and paint it before the first visible frame.
    const node = canvas.current!, context = node.getContext("2d", { alpha: false, desynchronized: true })!;
    // The live stroke need not wait for the page's compositor queue. Create its
    // low-latency context before pointerdown; unsupported browsers ignore it.
    overlay.current!.getContext("2d", { desynchronized: true });
    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, node.width, node.height);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      stroke.current = null;
      history.current.forEach(release);
      history.current = [];
      fillSurface.current = null;
    };
  }, []);
  useEffect(() => { if (busy) { stop(); setPickerOpen(false); } }, [busy]);

  function down(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || event.button !== 0 || stroke.current) return;
    const node = canvas.current!, context = node.getContext("2d")!;
    const p = point(event);
    setError("");
    if (tool === "fill") {
      // Only bucket fill reads pixels, using its own CPU-friendly surface.
      const surface = fillSurface.current ??= document.createElement("canvas");
      if (surface.width !== node.width || surface.height !== node.height) {
        surface.width = node.width; surface.height = node.height;
      }
      const readable = surface.getContext("2d", { willReadFrequently: true })!;
      readable.drawImage(node, 0, 0);
      const image = readable.getImageData(0, 0, node.width, node.height);
      const { r, g, b } = hexToRgb(color.hex);
      if (floodFill(image, Math.min(node.width - 1, p.x), Math.min(node.height - 1, p.y), [r, g, b, 255])) {
        save(snapshot());
        context.putImageData(image, 0, 0);
        drawingChanged(true);
        remember(color);
      }
      return;
    }
    save(snapshot());
    const layer = overlay.current!, ink = layer.getContext("2d")!;
    ink.clearRect(0, 0, layer.width, layer.height);
    ink.lineCap = "round";
    ink.lineJoin = "round";
    ink.lineWidth = [6, 12, 24][size] * (tool === "eraser" ? 2.5 : 1);
    ink.strokeStyle = ink.fillStyle = tool === "pen" ? color.hex : CANVAS_BACKGROUND;
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke.current = { pointerId: event.pointerId, pending: [], last: p, cursor: p, started: false, tool, color, width: ink.lineWidth };
    scheduleStroke();
    drawingChanged(true);
    if (tool === "pen") remember(color);
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    const current = stroke.current;
    if (current?.pointerId !== event.pointerId) return;
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of events.length ? events : [event.nativeEvent]) current.pending.push(point(sample));
    scheduleStroke();
  }
  async function undo() {
    if (busy || restoration.current) return;
    stop();
    const previous = history.current.pop();
    if (!previous) return;
    restoration.current = true;
    setRestoring(true);
    setHistoryLength(history.current.length);
    try {
      const image = await previous.image;
      if (!canvas.current) return;
      canvas.current.getContext("2d")!.drawImage(image, 0, 0);
      drawingChanged(previous.hasDrawing);
    } catch {
      if (canvas.current) setError("이전 그림을 되돌리지 못했어요. 현재 그림은 유지돼요.");
    } finally {
      release(previous);
      restoration.current = false;
      if (canvas.current) setRestoring(false);
    }
  }
  function clear() {
    stop();
    const node = canvas.current!, context = node.getContext("2d")!;
    save(snapshot());
    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, node.width, node.height);
    drawingChanged(false);
  }
  async function publish() {
    if (busy || blockedReason || !hasDrawing || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    stop();
    try { await onPublish(exportImage(canvas.current!)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "그림을 올리지 못했어요. 다시 시도해 주세요."); }
    finally { inFlight.current = false; setSending(false); }
  }

  return <div className="drawing-workspace">
    <div className="pg-card pg-canvas-card"><div style={{ position: "relative" }}><canvas width="680" height="680" ref={canvas} data-notouchfx
      aria-label="그림 그리는 캔버스" aria-disabled={busy} onPointerDown={down} onPointerMove={move}
      onPointerUp={event => { if (stroke.current?.pointerId === event.pointerId) { move(event); stop(); } }}
      onPointerCancel={event => { if (stroke.current?.pointerId === event.pointerId) stop(); }} onLostPointerCapture={stop} />
      <canvas width="680" height="680" ref={overlay} className="drawing-stroke-overlay" aria-hidden="true"
        style={{ position: "absolute", inset: 0, background: "transparent", pointerEvents: "none", opacity: tool === "pen" ? color.alpha : 1 }} /></div></div>
    <div className="pg-card drawing-tools" data-notouchfx>
      <div className="drawing-tool-row" role="group" aria-label="그리기 도구">
        {([['pen', '펜'], ['eraser', '지우개'], ['fill', '채우기']] as const).map(([name, label]) => <button key={name} type="button"
          aria-label={label} aria-pressed={tool === name} disabled={busy} onClick={() => setTool(name)}><ToolIcon tool={name} /></button>)}
        <button className="drawing-color-button" type="button" aria-label="색상 고르기" disabled={busy}
          onClick={() => { if (tool === "eraser") setTool("pen"); setPickerOpen(true); }}>
          <span style={{ background: color.hex, opacity: tool === "fill" ? 1 : color.alpha }} />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>
      <div className="drawing-width-row" role="group" aria-label="펜 두께">
        {[8, 14, 22].map((diameter, index) => <button key={diameter} type="button" aria-label={`펜 두께 ${index + 1}`} aria-pressed={size === index}
          disabled={busy || tool === "fill"} onClick={() => setSize(index)}><span style={{ width: diameter, height: diameter }} /></button>)}
        <button className="drawing-undo" type="button" aria-label="한 획 되돌리기" disabled={busy || !historyLength} onClick={() => void undo()}>되돌리기</button>
        <button type="button" disabled={busy || !hasDrawing} onClick={clear}>전체 지우기</button>
      </div>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    {blockedReason && hasDrawing && !busy && <p className="subtle-note drawing-blocked" role="status">{blockedReason}</p>}
    <button type="button" className="primary-button pg-full" disabled={busy || Boolean(blockedReason) || !hasDrawing} onClick={() => void publish()}>{publishing || sending ? "그림 올리는 중…" : "그림 올리기"}</button>
    {pickerOpen && <ColorPicker value={color} onChange={setColor} onCommit={remember} recentColors={recentColors}
      allowAlpha={tool !== "fill"} onClose={() => setPickerOpen(false)} />}
  </div>;
});
