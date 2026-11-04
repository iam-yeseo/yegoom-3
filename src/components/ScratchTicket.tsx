import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { SpeettoTicket } from "../../shared/types";
import { art, artSrc } from "./UI";
import { confetti, crumbs, popIn, reduced, tween } from "../motion";
import { SCRATCH_FONT, SCRATCH_LABEL, scratchBitmapSize, scratchMark, scratchedRatio } from "../scratch";

/** A purchased result is only revealed here; scratching never changes a balance. */
export function ScratchTicket({ ticket, revealed: savedRevealed = false, onReveal }: {
  ticket: SpeettoTicket; revealed?: boolean; onReveal?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const symbols = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const scratching = useRef(false);
  const strokes = useRef(0);
  const ready = useRef(savedRevealed);
  const celebrate = useRef(false);
  const [localRevealed, setLocalRevealed] = useState(savedRevealed);
  const [coverReady, setCoverReady] = useState(savedRevealed);
  const [prize, setPrize] = useState(savedRevealed ? ticket.prize : 0);
  const revealed = savedRevealed || localRevealed;
  const shown = useRef(revealed);
  shown.current = revealed;

  function reveal() {
    if (shown.current) return;
    shown.current = true;
    scratching.current = false;
    celebrate.current = true;
    setLocalRevealed(true);
    onReveal?.();
  }

  useEffect(() => {
    if (!revealed) return;
    // Selecting an already revealed history row must not celebrate/pay again.
    if (!celebrate.current) { setPrize(ticket.prize); return; }
    const effects = [...(symbols.current?.children ?? [])].map((element, i) => popIn(element, { delay: 450 + i * 150 }));
    let stop = () => {};
    const timer = ticket.won ? window.setTimeout(() => {
      confetti(symbols.current);
      stop = tween(0, ticket.prize, 900, value => setPrize(Math.round(value)));
    }, reduced() ? 0 : 450 + ticket.cells.length * 150) : null;
    return () => { if (timer !== null) clearTimeout(timer); stop(); effects.forEach(effect => effect?.cancel()); };
  }, [revealed, ticket.won, ticket.prize, ticket.cells.length]);

  useLayoutEffect(() => {
    const node = canvas.current;
    if (!node || shown.current) return;
    const context = node.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    let alive = true, fontReady = false;
    let painted = { width: 0, height: 0, ratio: 0, fontReady: false };
    function paint() {
      // Resizing an in-progress bitmap would erase the user's scratched areas.
      if (!alive || started.current || shown.current) return;
      const bounds = node!.getBoundingClientRect();
      if (!(bounds.width > 0 && bounds.height > 0)) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (painted.width === bounds.width && painted.height === bounds.height && painted.ratio === ratio && painted.fontReady === fontReady) return;
      const pixels = scratchBitmapSize(bounds.width, bounds.height, ratio);
      node!.width = pixels.width; node!.height = pixels.height;
      context!.setTransform(pixels.width / bounds.width, 0, 0, pixels.height / bounds.height, 0, 0);
      context!.globalCompositeOperation = "source-over";
      const gradient = context!.createLinearGradient(0, 0, bounds.width, bounds.height);
      gradient.addColorStop(0, "#D8CCF7"); gradient.addColorStop(1, "#C4DFF5");
      context!.fillStyle = gradient;
      context!.fillRect(0, 0, bounds.width, bounds.height);
      context!.fillStyle = "rgba(255,255,255,.35)";
      for (let i = 0; i < 60; i++) {
        context!.beginPath(); context!.arc((i * 97) % bounds.width, (i * 53) % bounds.height, 3, 0, Math.PI * 2); context!.fill();
      }
      if (fontReady) {
        let size = 20;
        const font = (value: number) => `800 ${value}px TmoneyRoundWind, Pretendard Variable, sans-serif`;
        context!.font = font(size);
        const width = context!.measureText(SCRATCH_LABEL).width;
        if (width > bounds.width * .8) size *= bounds.width * .8 / width;
        context!.font = font(size);
        // Fractional font metrics can round differently at the final size.
        while (context!.measureText(SCRATCH_LABEL).width > bounds.width * .8 && size > .25) {
          size = Math.max(.25, size - .25); context!.font = font(size);
        }
        context!.fillStyle = "#fff";
        context!.textAlign = "center"; context!.textBaseline = "middle";
        context!.fillText(SCRATCH_LABEL, bounds.width / 2, bounds.height / 2);
        ready.current = true;
        setCoverReady(true);
      }
      painted = { width: bounds.width, height: bounds.height, ratio, fontReady };
    }
    // Cover the symbols before the first paint; the text waits for its font.
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(node);
    window.addEventListener("resize", paint);
    let font: Promise<unknown>;
    try { font = document.fonts?.load(SCRATCH_FONT, SCRATCH_LABEL) ?? Promise.resolve(); }
    catch { font = Promise.resolve(); }
    void font.catch(() => {}).then(() => {
      if (!alive) return;
      fontReady = true;
      paint();
    });
    return () => { alive = false; observer.disconnect(); window.removeEventListener("resize", paint); scratching.current = false; };
  }, []);

  function scratch(event: PointerEvent<HTMLCanvasElement>) {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context || shown.current || !ready.current) return;
    const bounds = node.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0)) return;
    const mark = scratchMark(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height, node.width, node.height);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "destination-out";
    context.beginPath(); context.ellipse(mark.x, mark.y, mark.radiusX, mark.radiusY, 0, 0, Math.PI * 2); context.fill();
    crumbs(event.clientX, event.clientY);
    strokes.current++;
    if (strokes.current % 8 === 0 && scratchedRatio(context.getImageData(0, 0, node.width, node.height), bounds.width, bounds.height) > .6) reveal();
  }

  return <section className="scratch-card" data-ticket-id={ticket.id}>
    <div className="card-head"><h2>예굼 스피또</h2><span className="scratch-ticket-number">No. {ticket.id.slice(-8)}</span></div>
    <div className="scratch-area">
      <div className="scratch-symbols" ref={symbols}>{ticket.cells.map((key, i) => <span key={i} style={{ background: art[key].tint }}><img className="character" src={artSrc(key)} alt={art[key].name} /></span>)}</div>
      <canvas ref={canvas} className={revealed ? "revealed" : ""} aria-label="긁는 영역. 손가락이나 마우스로 문질러 주세요." aria-busy={!coverReady && !revealed}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary || shown.current || !ready.current) return;
          event.currentTarget.setPointerCapture(event.pointerId); started.current = true; scratching.current = true; scratch(event);
        }} onPointerMove={event => { if (scratching.current) scratch(event); }}
        onPointerUp={() => { scratching.current = false; }} onPointerCancel={() => { scratching.current = false; }} onLostPointerCapture={() => { scratching.current = false; }} />
    </div>
    <div className={`scratch-result ${revealed ? ticket.won ? "won" : "lost" : ""}`} aria-live="polite">{revealed ? ticket.won ? `당첨! +${prize.toLocaleString("ko-KR")}G` : "아쉽지만 낙첨이에요" : "?"}</div>
    {!revealed && <button className="text-button" onClick={reveal}>한 번에 긁기</button>}
  </section>;
}
