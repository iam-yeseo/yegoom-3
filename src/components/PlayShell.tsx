import { useEffect, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LaunchDialog } from "../launch-gift";
import "../play-shell.css";

/** A full-screen play view, like a small app of its own: a top bar (close,
 * progress), the game stage scaled to fit whatever space is left, and the
 * controls at the bottom. Nothing on the page scrolls while it is open. */
export function PlayShell({ label, theme, stage, top, right, bottom, onClose, children }: {
  label: string;
  /** Background colours around the stage. */
  theme: { background: string; text?: string; tone?: "dark" | "light" };
  /** Width / height of the stage; it keeps this shape and fills the space. */
  stage: { width: number; height: number; content: ReactNode };
  top: ReactNode;
  right?: ReactNode;
  bottom: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);
  return createPortal(<section className="play-shell" role="region" aria-label={label} data-tone={theme.tone ?? "dark"}
    style={{ "--play-bg": theme.background, "--play-text": theme.text ?? "#fff", "--stage-ratio": `${stage.width} / ${stage.height}`,
      "--stage-w": stage.width, "--stage-h": stage.height } as CSSProperties}>
    <header className="play-top">
      <button type="button" className="play-close" aria-label="나가기" onClick={onClose}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <div className="play-top-main">{top}</div>
      {right && <div className="play-top-right">{right}</div>}
    </header>
    <div className="play-stage"><div className="play-frame" data-notouchfx>{stage.content}</div></div>
    <footer className="play-bottom">{bottom}</footer>
    {children}
  </section>, document.body);
}

/** Segments for each turn of a run: done (hit or miss), the current one, the rest. */
export function PlayProgress({ marks, total, current, label }: { marks: (boolean | null | undefined)[]; total: number; current: number | null; label: string }) {
  const done = marks.filter(mark => mark === true || mark === false).length;
  return <div className="play-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
    <span className="play-progress-bar">{Array.from({ length: total }, (_, i) => {
      const mark = marks[i];
      return <i key={i} className={mark === true ? "is-hit" : mark === false ? "is-miss" : i === current ? "is-now" : ""} />;
    })}</span>
    <b>{Math.min(done, total)}<span>/{total}</span></b>
  </div>;
}

/** Leaving mid-run ends it unfinished: ask first. */
export function QuitDialog({ title, detail, stay, onStay, onQuit }: { title: string; detail: string; stay: string; onStay: () => void; onQuit: () => void }) {
  return <LaunchDialog title={title} onClose={onStay} className="play-quit-dialog">
    <p>{detail}</p>
    <div className="play-quit-actions">
      <button className="primary-button" type="button" onClick={onStay}>{stay}</button>
      <button className="text-button" type="button" onClick={onQuit}>그만두기</button>
    </div>
  </LaunchDialog>;
}

/** The result shown when a recorded run ends. Closing never waits for the record:
 * a record still on its way is kept on the device and re-sent. */
export type RecordStatus = "saving" | "saved" | "retry" | "refused";
export function ResultDialog({ title, art, lines, status, message, onRetry, onClose }: {
  title: string; art?: string; lines: ReactNode; status: RecordStatus; message?: string; onRetry: () => void; onClose: () => void;
}) {
  return <LaunchDialog title={title} onClose={onClose} className="play-result-dialog">
    {art && <img className="play-result-art" src={art} alt="" />}
    <div className="play-result-lines">{lines}</div>
    <p className={`play-result-status is-${status}`} role="status">
      {status === "saving" ? "기록하는 중…" : status === "saved" ? "기록했어요" : status === "retry" ? "기록을 보내지 못했어요." : message || "기록하지 못했어요."}
      {status === "retry" && <button type="button" className="text-button" onClick={onRetry}>다시 보내기</button>}
    </p>
    <button className="primary-button" type="button" onClick={onClose}>확인</button>
  </LaunchDialog>;
}
