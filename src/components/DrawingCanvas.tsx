import { useEffect, useRef, useState, type PointerEvent } from "react";
import { CATCHMIND_RULES } from "../../shared/balance";
import { clamp, hexToRgb, rememberColor, type PaintColor } from "../color";
import { CANVAS_BACKGROUND, floodFill } from "../drawing";
import { ColorPicker } from "./ColorPicker";

type Tool = "pen" | "eraser" | "fill";
type Point = { x: number; y: number };
interface Snapshot { image: ImageData; hasDrawing: boolean }
interface Stroke { pointerId: number; points: Point[]; before: ImageData; tool: "pen" | "eraser"; color: PaintColor; width: number }
interface DrawingCanvasProps {
  disabled?: boolean;
  publishing?: boolean;
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

export function DrawingCanvas({ disabled = false, publishing = false, onPublish }: DrawingCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<Snapshot[]>([]);
  const stroke = useRef<Stroke | null>(null);
  const [historyLength, setHistoryLength] = useState(0);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [color, setColor] = useState<PaintColor>({ hex: "#5E6A8A", alpha: 1 });
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [size, setSize] = useState(1);
  const [tool, setTool] = useState<Tool>("pen");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const busy = disabled || publishing || sending;

  function remember(selected: PaintColor) { setRecentColors(previous => rememberColor(previous, selected.hex)); }
  function stop() {
    const current = stroke.current;
    stroke.current = null;
    if (current && canvas.current?.hasPointerCapture(current.pointerId)) canvas.current.releasePointerCapture(current.pointerId);
  }
  useEffect(() => {
    const context = canvas.current!.getContext("2d")!;
    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, canvas.current!.width, canvas.current!.height);
    return stop;
  }, []);
  useEffect(() => { if (busy) { stop(); setPickerOpen(false); } }, [busy]);

  function point(event: { clientX: number; clientY: number }): Point {
    const node = canvas.current!, rect = node.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width) * node.width, y: clamp((event.clientY - rect.top) / rect.height) * node.height };
  }
  function save(image: ImageData) {
    history.current = [...history.current.slice(-9), { image, hasDrawing }];
    setHistoryLength(history.current.length);
  }
  function renderStroke() {
    const current = stroke.current, context = canvas.current?.getContext("2d");
    if (!current || !context) return;
    // Redraw from the snapshot so translucent segments do not darken at every pointermove.
    context.putImageData(current.before, 0, 0);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = current.width;
    context.globalAlpha = current.tool === "pen" ? current.color.alpha : 1;
    context.strokeStyle = context.fillStyle = current.tool === "pen" ? current.color.hex : CANVAS_BACKGROUND;
    const points = current.points;
    context.beginPath();
    if (points.length === 1) {
      context.arc(points[0].x, points[0].y, current.width / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1], next = points[index];
        context.quadraticCurveTo(previous.x, previous.y, (previous.x + next.x) / 2, (previous.y + next.y) / 2);
      }
      const last = points[points.length - 1];
      context.lineTo(last.x, last.y);
      context.stroke();
    }
    context.restore();
  }
  function down(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || event.button !== 0 || stroke.current) return;
    const node = canvas.current!, context = node.getContext("2d")!;
    const p = point(event), before = context.getImageData(0, 0, node.width, node.height);
    setError("");
    if (tool === "fill") {
      const image = new ImageData(before.data.slice(), node.width, node.height);
      const { r, g, b } = hexToRgb(color.hex);
      if (floodFill(image, Math.min(node.width - 1, p.x), Math.min(node.height - 1, p.y), [r, g, b, 255])) {
        save(before);
        context.putImageData(image, 0, 0);
        setHasDrawing(true);
        remember(color);
      }
      return;
    }
    save(before);
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke.current = { pointerId: event.pointerId, points: [p], before, tool, color, width: [6, 12, 24][size] * (tool === "eraser" ? 2.5 : 1) };
    renderStroke();
    setHasDrawing(true);
    if (tool === "pen") remember(color);
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (stroke.current?.pointerId !== event.pointerId) return;
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of events.length ? events : [event.nativeEvent]) stroke.current.points.push(point(sample));
    renderStroke();
  }
  function undo() {
    stop();
    const previous = history.current.pop();
    if (!previous) return;
    canvas.current!.getContext("2d")!.putImageData(previous.image, 0, 0);
    setHistoryLength(history.current.length);
    setHasDrawing(previous.hasDrawing);
  }
  function clear() {
    stop();
    const node = canvas.current!, context = node.getContext("2d")!;
    save(context.getImageData(0, 0, node.width, node.height));
    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, node.width, node.height);
    setHasDrawing(false);
  }
  async function publish() {
    if (busy || !hasDrawing || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    stop();
    try { await onPublish(exportImage(canvas.current!)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "그림을 올리지 못했어요. 다시 시도해 주세요."); }
    finally { inFlight.current = false; setSending(false); }
  }

  return <div className="drawing-workspace">
    <div className="pg-card pg-canvas-card"><canvas width="680" height="680" ref={canvas} data-notouchfx
      aria-label="그림 그리는 캔버스" aria-disabled={busy} onPointerDown={down} onPointerMove={move}
      onPointerUp={event => { if (stroke.current?.pointerId === event.pointerId) { move(event); stop(); } }}
      onPointerCancel={event => { if (stroke.current?.pointerId === event.pointerId) stop(); }} onLostPointerCapture={stop} /></div>
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
        <button className="drawing-undo" type="button" aria-label="한 획 되돌리기" disabled={busy || !historyLength} onClick={undo}>되돌리기</button>
        <button type="button" disabled={busy || !hasDrawing} onClick={clear}>전체 지우기</button>
      </div>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <button type="button" className="primary-button pg-full" disabled={busy || !hasDrawing} onClick={() => void publish()}>{publishing || sending ? "그림 올리는 중…" : "그림 올리기"}</button>
    {pickerOpen && <ColorPicker value={color} onChange={setColor} onCommit={remember} recentColors={recentColors}
      allowAlpha={tool !== "fill"} onClose={() => setPickerOpen(false)} />}
  </div>;
}
