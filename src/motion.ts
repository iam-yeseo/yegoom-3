import { useEffect, useRef, useState } from "react";

// Motion tokens and helpers from the Claude Design motion spec
// (Yegoom Motion Spec, yegoom-motion.js). Everything animates transform
// (scale / translate / rotate) or opacity through the Web Animations API, so
// it composes with layout transforms. With reduced motion, movement is dropped
// and only fades of 200ms or less remain; particles and loops are skipped.

const reducedQuery =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const hasLinear =
  typeof CSS !== "undefined" && CSS.supports?.("transition-timing-function", "linear(0, 1)");

export const dur = {
  press: 120,
  xs: 150,
  s: 200,
  m: 260,
  l: 300,
  spring: 420,
  reveal: 520,
  celebrate: 1200,
} as const;
export const ease = {
  out: "cubic-bezier(.22,1,.36,1)",
  inOut: "cubic-bezier(.65,0,.35,1)",
  spring: hasLinear
    ? "linear(0, 0.157 4.3%, 0.522 10.3%, 0.82 16.5%, 1.004 23%, 1.083 28.7%, 1.094 33%, 1.071 38.3%, 1.004 50.6%, 0.988 58.5%, 0.994 71.4%, 1)"
    : "cubic-bezier(.34,1.4,.64,1)",
  linear: "linear",
} as const;
export type Ease = keyof typeof ease;
const colors = ["#FF8E7A", "#FFD866", "#8FD9C0", "#B9A3F0", "#8CC8F2", "#FFB9A6"];

export const reduced = () => !!reducedQuery?.matches;

type Frame = Keyframe & { scale?: string; translate?: string; rotate?: string };
interface Opts {
  dur?: number;
  ease?: Ease | string;
  delay?: number;
  fill?: FillMode;
  iter?: number;
}
export function anim(el: Element | null | undefined, frames: Frame[], o: Opts = {}) {
  if (!el || !("animate" in el)) return null;
  const options: KeyframeAnimationOptions = {
    duration: o.dur ?? dur.m,
    easing: ease[o.ease as Ease] ?? o.ease ?? ease.out,
    delay: o.delay ?? 0,
    fill: o.fill ?? "both",
    iterations: o.iter ?? 1,
  };
  if (reduced()) {
    if (!frames.some((f) => "opacity" in f)) return null;
    return el.animate(
      frames.map((f) => ({ opacity: f.opacity ?? 1 })),
      { ...options, duration: Math.min(Number(options.duration), 200), easing: "linear" },
    );
  }
  return el.animate(frames, options);
}
export const pop = (el: Element | null | undefined, s = 1.16, o: Opts = {}) =>
  anim(el, [{ scale: "1" }, { scale: String(s), offset: 0.35 }, { scale: "1" }], {
    dur: dur.spring,
    ease: "out",
    ...o,
  });
export const popIn = (el: Element | null | undefined, o: Opts = {}) =>
  anim(el, [{ scale: ".4", opacity: 0 }, { scale: "1", opacity: 1 }], {
    dur: dur.spring,
    ease: "spring",
    ...o,
  });
export const flip = (el: Element | null | undefined, o: Opts = {}) =>
  anim(
    el,
    [
      { transform: "perspective(240px) rotateX(-90deg)", opacity: 0 },
      { transform: "perspective(240px) rotateX(0deg)", opacity: 1 },
    ],
    { dur: dur.l, ease: "spring", ...o },
  );
export const flipY = (el: Element | null | undefined, o: Opts = {}) =>
  anim(
    el,
    [
      { transform: "perspective(300px) rotateY(90deg)", opacity: 0 },
      { transform: "perspective(300px) rotateY(0deg)", opacity: 1 },
    ],
    { dur: dur.reveal, ease: "spring", ...o },
  );
export const shake = (el: Element | null | undefined) =>
  anim(
    el,
    [
      { translate: "0 0" },
      { translate: "-9px 0" },
      { translate: "8px 0" },
      { translate: "-5px 0" },
      { translate: "3px 0" },
      { translate: "0 0" },
    ],
    { dur: dur.l, ease: "out", fill: "none" },
  );
export const rise = (el: Element | null | undefined, o: Opts = {}) =>
  anim(el, [{ translate: "0 14px", opacity: 0 }, { translate: "0 0", opacity: 1 }], {
    dur: dur.l,
    ease: "spring",
    ...o,
  });
export const fadeIn = (el: Element | null | undefined, o: Opts = {}) =>
  anim(el, [{ opacity: 0 }, { opacity: 1 }], { dur: dur.s, ...o });

// Characters: static images, transform only, pivoting at the feet.
function feet(el: Element | null | undefined) {
  if (el instanceof HTMLElement || el instanceof SVGElement) el.style.transformOrigin = "50% 100%";
}
export function greet(el: Element | null | undefined, o: Opts = {}) {
  feet(el);
  return anim(
    el,
    [
      { rotate: "0deg", translate: "0 0", scale: "1 1" },
      { rotate: "0deg", translate: "0 0", scale: "1.06 .94", offset: 0.14 },
      { rotate: "-7deg", translate: "0 -18px", scale: ".97 1.04", offset: 0.38 },
      { rotate: "6deg", translate: "0 -8px", scale: "1 1", offset: 0.6 },
      { rotate: "-3deg", translate: "0 0", scale: "1.04 .96", offset: 0.8 },
      { rotate: "0deg", translate: "0 0", scale: "1 1" },
    ],
    { dur: 900, ease: "inOut", fill: "none", ...o },
  );
}
export function squishJump(el: Element | null | undefined) {
  feet(el);
  return anim(
    el,
    [
      { scale: "1 1", translate: "0 0" },
      { scale: "1.18 .8", translate: "0 0", offset: 0.18 },
      { scale: ".9 1.12", translate: "0 -38px", offset: 0.45 },
      { scale: "1 1", translate: "0 -42px", offset: 0.55 },
      { scale: "1.14 .86", translate: "0 0", offset: 0.78 },
      { scale: "1 1", translate: "0 0" },
    ],
    { dur: 680, ease: "inOut", fill: "none" },
  );
}
export function hop(el: Element | null | undefined, o: Opts = {}) {
  feet(el);
  return anim(
    el,
    [
      { scale: "1 1", translate: "0 0" },
      { scale: "1.08 .9", translate: "0 0", offset: 0.12 },
      { scale: ".95 1.07", translate: "0 -30px", offset: 0.3 },
      { scale: "1.06 .94", translate: "0 0", offset: 0.48 },
      { scale: ".96 1.05", translate: "0 -20px", offset: 0.66 },
      { scale: "1.05 .95", translate: "0 0", offset: 0.84 },
      { scale: "1 1", translate: "0 0" },
    ],
    { dur: 1000, ease: "inOut", fill: "none", ...o },
  );
}
/** Drops a character in from above and lands it with a squash. */
export function dropIn(el: Element | null | undefined, o: Opts = {}) {
  feet(el);
  return anim(
    el,
    [
      { translate: "0 -160px", scale: ".9 1.1", opacity: 0 },
      { translate: "0 0", scale: "1.16 .84", opacity: 1, offset: 0.55 },
      { translate: "0 -10px", scale: ".96 1.05", offset: 0.75 },
      { translate: "0 0", scale: "1 1", opacity: 1 },
    ],
    { dur: 900, ease: "inOut", ...o },
  );
}

/** Tweens a number with ease-out cubic; returns a cancel function. */
export function tween(from: number, to: number, ms: number, step: (v: number) => void, done?: () => void) {
  const d = reduced() ? 0 : ms;
  if (!d || from === to) {
    step(to);
    done?.();
    return () => {};
  }
  const start = performance.now();
  let id = 0;
  const tick = () => {
    const t = Math.min(1, (performance.now() - start) / d);
    step(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) id = requestAnimationFrame(tick);
    else done?.();
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}
/** The displayed value of `value`, counting from the previous value when it changes. */
export function useCountUp(value: number, ms = 700) {
  const [shown, setShown] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    const from = last.current;
    last.current = value;
    return tween(from, value, ms, (v) => setShown(Math.round(v)));
  }, [value, ms]);
  return shown;
}

// Effects layer: a fixed overlay over the app column for particles and toasts.
let layerEl: HTMLDivElement | null = null;
export function fxLayer() {
  if (layerEl?.isConnected) return layerEl;
  layerEl = document.createElement("div");
  layerEl.className = "fx-layer";
  layerEl.setAttribute("aria-hidden", "true");
  document.body.appendChild(layerEl);
  return layerEl;
}
function rel(el: Element) {
  const layer = fxLayer().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - layer.left, y: r.top + r.height / 2 - layer.top };
}
function dot(x: number, y: number, size: number, color: string, round = true) {
  const d = document.createElement("div");
  d.style.cssText = `position:absolute;left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${round ? size : size * 0.55}px;border-radius:${round ? "50%" : "3px"};background:${color};pointer-events:none`;
  fxLayer().appendChild(d);
  return d;
}
const at = (el: Element | null | undefined) => (el ? rel(el) : null);
export function confetti(from: Element | null | undefined, o: { n?: number; spread?: number } = {}) {
  const p = at(from);
  if (!p || reduced()) return;
  const n = o.n ?? 26;
  const spread = o.spread ?? 150;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const r = spread * (0.5 + Math.random() * 0.6);
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r * 0.7 - 40;
    const d = dot(p.x, p.y, 7 + Math.random() * 5, colors[i % 6], i % 3 === 0);
    d.animate(
      [
        { translate: "0 0", rotate: "0deg", opacity: 1, scale: ".4" },
        { translate: `${dx}px ${dy}px`, rotate: `${Math.random() * 300}deg`, opacity: 1, scale: "1", offset: 0.45 },
        { translate: `${dx * 1.15}px ${dy + 110}px`, rotate: `${Math.random() * 500}deg`, opacity: 0, scale: ".9" },
      ],
      { duration: 1100 + Math.random() * 200, easing: "cubic-bezier(.2,.7,.4,1)", fill: "both" },
    );
    setTimeout(() => d.remove(), 1600);
  }
}
export function sparkle(from: Element | null | undefined, o: { n?: number; r?: number; color?: string; delay?: number } = {}) {
  const p = at(from);
  if (!p || reduced()) return;
  const n = o.n ?? 6;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    const r = o.r ?? 34;
    const d = dot(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 6, o.color ?? "#FFD866");
    d.animate(
      [
        { scale: "0", opacity: 0 },
        { scale: "1.3", opacity: 1, offset: 0.4 },
        { scale: "0", opacity: 0 },
      ],
      { duration: 700, delay: i * 60 + (o.delay ?? 0), easing: ease.out, fill: "both" },
    );
    setTimeout(() => d.remove(), 1600);
  }
}
/** Lilac scratch dust at a client point. */
export function crumbs(clientX: number, clientY: number) {
  if (reduced()) return;
  const layer = fxLayer().getBoundingClientRect();
  const x = clientX - layer.left;
  const y = clientY - layer.top;
  for (let i = 0; i < 2; i++) {
    const d = dot(x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 20, 4 + Math.random() * 4, ["#D8CCF7", "#C4DFF5", "#E9E2FB"][i % 3]);
    d.animate(
      [
        { translate: "0 0", opacity: 0.9 },
        { translate: `${(Math.random() - 0.5) * 30}px ${30 + Math.random() * 30}px`, opacity: 0 },
      ],
      { duration: 600, easing: "cubic-bezier(.3,.6,.5,1)", fill: "both" },
    );
    setTimeout(() => d.remove(), 1600);
  }
}
/** Flies gold coins from one element to another, then pops the target. */
export function coinFly(from: Element | null | undefined, to: Element | null | undefined, onArrive?: () => void, n = 6) {
  const a = at(from);
  const b = at(to);
  if (!a || !b || reduced()) {
    onArrive?.();
    return;
  }
  let first = true;
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "fx-coin";
    c.textContent = "G";
    c.style.left = `${a.x - 12}px`;
    c.style.top = `${a.y - 12}px`;
    fxLayer().appendChild(c);
    const jx = (Math.random() - 0.5) * 60;
    c.animate(
      [
        { translate: "0 0", scale: ".6", opacity: 0 },
        { translate: `${jx}px ${-40 - Math.random() * 30}px`, scale: "1.1", opacity: 1, offset: 0.3 },
        { translate: `${b.x - a.x}px ${b.y - a.y}px`, scale: ".7", opacity: 1 },
      ],
      { duration: 700, delay: i * 70, easing: ease.inOut, fill: "both" },
    );
    setTimeout(() => {
      c.remove();
      pop(to, 1.12);
      if (first) {
        first = false;
        onArrive?.();
      }
    }, 700 + i * 70);
  }
}
/** A short confirmation pill near the bottom of the app column. */
export function toast(text: string, o: { hold?: number } = {}) {
  const t = document.createElement("div");
  t.className = "fx-toast";
  t.setAttribute("role", "status");
  t.innerHTML = `<span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${reduced() ? 0 : 1}"></path></svg></span>`;
  t.appendChild(document.createTextNode(text));
  // Toasts are announced, so they live outside the aria-hidden layer.
  document.body.appendChild(t);
  anim(t, [{ translate: "-50% 24px", opacity: 0, scale: ".9" }, { translate: "-50% 0", opacity: 1, scale: "1" }], {
    dur: dur.spring,
    ease: "spring",
  });
  if (!reduced())
    t.querySelector("path")?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
      duration: 320,
      delay: 180,
      easing: ease.out,
      fill: "both",
    });
  setTimeout(() => {
    anim(t, [{ opacity: 1, translate: "-50% 0" }, { opacity: 0, translate: "-50% 12px" }], { dur: dur.s });
    setTimeout(() => t.remove(), 240);
  }, o.hold ?? 1700);
}

/** Global press feedback for buttons and [data-press] elements. */
export function installPressFeedback() {
  const selector = "button,[data-press]";
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>(selector);
      if (!el || (el as HTMLButtonElement).disabled || el.closest("[data-nopress]")) return;
      const scale = el.offsetWidth > 220 ? 0.975 : 0.94;
      const shadow = getComputedStyle(el).boxShadow;
      const pressed: Keyframe = { scale: String(scale) };
      if (shadow && shadow !== "none") pressed.boxShadow = "0 2px 8px rgba(120,90,60,.10)";
      const down = reduced()
        ? el.animate([{ opacity: 1 }, { opacity: 0.82 }], { duration: 80, fill: "forwards" })
        : el.animate([{ scale: "1" }, pressed], { duration: dur.press, easing: ease.out, fill: "forwards" });
      const up = () => {
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (reduced()) el.animate([{ opacity: 0.82 }, { opacity: 1 }], { duration: 120 });
        else el.animate([pressed, { scale: "1" }], { duration: dur.spring, easing: ease.spring });
        down.cancel();
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    true,
  );
}

/** Runs `fn` with the element after mount (skips when the element is missing). */
export function useMountMotion<T extends Element>(fn: (el: T) => void, deps: unknown[] = []) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (ref.current) fn(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
/** Calls `fn` when `value` changes after the first render. */
export function useOnChange<V>(value: V, fn: (prev: V) => void) {
  const prev = useRef(value);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    const old = prev.current;
    prev.current = value;
    fn(old);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}
