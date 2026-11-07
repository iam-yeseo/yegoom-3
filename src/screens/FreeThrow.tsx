import { useEffect, useRef, useState } from "react";
import { FREETHROW_RULES } from "../../shared/balance";
import type { ShotInput, ShotResult } from "../../shared/freethrow-physics";
import type { User } from "../../shared/types";
import { Toolbar } from "../components/UI";
import { anim, reduced } from "../motion";
import { FreeThrowController, type ThrowMode } from "../freethrow/controller";
import { STAGE } from "../freethrow/render";
import { createFreeThrowSound, type FreeThrowSound } from "../freethrow/sound";
import "../freethrow/freethrow.css";

const HOURS = Array.from({ length: 24 * 60 * 60 * 1000 / FREETHROW_RULES.setIntervalMs }, (_, i) => String(i * FREETHROW_RULES.setIntervalMs / 3_600_000).padStart(2, "0")).join("·");

/** What the player reads after each shot: what happened, then how to adjust. */
export function shotCopy(result: ShotResult): { title: string; detail: string } {
  const side = (left: boolean) => (left ? "왼쪽" : "오른쪽");
  switch (result.kind) {
    case "swish": return { title: "클린 슛!", detail: "그물만 스쳤어요. 림은 공이 지나간 줄도 몰라요." };
    case "bank": return { title: "뱅크 슛!", detail: "백보드가 한 번 도와줬어요. 계획한 거라고 우기면 계획한 거예요." };
    case "rim-in": return { title: "림 맞고 골!", detail: "림이 잠깐 고민하더니 들여보내 줬어요." };
    case "rim-out":
      if (result.firstRim === "front") return { title: "앞 림에 걸렸어요", detail: "아주 조금 약했어요. 살짝만 더 빠르게 올려 보세요." };
      if (result.firstRim === "back") return { title: "뒷 림 맞고 튕겼어요", detail: "아주 조금 셌어요. 힘을 살짝 빼 보세요." };
      return { title: `림 ${side(result.firstRim === "left")}에 맞았어요`, detail: `방향이 살짝 ${side(result.firstRim === "left")}이었어요. 더 곧게 올려 보세요.` };
    case "board-out": return { title: "백보드 맞고 튕겨 나왔어요", detail: "너무 셌어요. 백보드도 깜짝 놀랐대요. 힘을 빼 보세요." };
    case "short": return { title: "짧았어요", detail: "골대까지 못 갔어요. 더 빠르게 쓸어 올려 보세요." };
    case "long": return { title: "너무 길었어요", detail: "힘을 빼고 조금 천천히 올려 보세요." };
    case "left": case "right": return { title: `${side(result.kind === "left")}으로 빗나갔어요`, detail: `손가락이 ${side(result.kind === "left")}으로 기울었어요. 위로 곧게!` };
  }
}
export const aimLabel = (aim: number) => (aim === 0 ? "가운데" : `${aim < 0 ? "왼쪽" : "오른쪽"} ${Math.abs(aim)}`);

interface Stats { shots: number; made: number; streak: number; best: number; recent: boolean[] }
const emptyStats = (): Stats => ({ shots: 0, made: 0, streak: 0, best: 0, recent: [] });

export function FreeThrow({ user, onBack }: { user: User; onBack: () => void; demo?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<FreeThrowController | null>(null);
  const sound = useRef<FreeThrowSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ThrowMode>("idle");
  const [stats, setStats] = useState(emptyStats);
  const [last, setLast] = useState<{ result: ShotResult; streak: number } | null>(null);
  const [lastInput, setLastInput] = useState<ShotInput | null>(null);
  const [hint, setHint] = useState("");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [thrown, setThrown] = useState(false);
  const streak = useRef(0);

  useEffect(() => {
    const effects = createFreeThrowSound();
    sound.current = effects; setMuted(effects.muted);
    let runtime: FreeThrowController;
    try {
      runtime = new FreeThrowController(canvas.current!, effects, {
        onMode: setMode,
        onThrow: input => { setLastInput(input); setHint(""); setThrown(true); },
        onCancel: () => setHint("공을 아래로 당겼다가 위로 빠르게 쓸어 올리며 놓아요."),
        onResult: result => {
          streak.current = result.made ? streak.current + 1 : 0;
          const current = streak.current;
          setStats(stats => ({ shots: stats.shots + 1, made: stats.made + Number(result.made), streak: current,
            best: Math.max(stats.best, current), recent: [...stats.recent, result.made].slice(-FREETHROW_RULES.shotsPerSet) }));
          setLast({ result, streak: current });
          if (result.made) effects.cheer(current); else if (result.kind !== "rim-out") effects.sad();
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
        },
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "코트를 표시하지 못했어요."); return; }
    controller.current = runtime;
    const hide = () => runtime.setEnabled(!document.hidden);
    document.addEventListener("visibilitychange", hide);
    return () => { runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", hide); };
  }, []);

  function toggleSound() {
    const next = !muted;
    sound.current?.setMuted(next); setMuted(next);
  }
  function reset() {
    streak.current = 0; setStats(emptyStats()); setLast(null); setLastInput(null);
  }
  const rate = stats.shots ? Math.round((stats.made / stats.shots) * 100) : 0;
  const copy = last ? shotCopy(last.result) : null;
  return <section className="freethrow-page">
    <Toolbar title="자유투 대결" onBack={onBack} gold={user.gold} />
    <section className="freethrow-mode card" aria-label="게임 모드">
      <div><strong>연습 모드</strong><small>마음껏 던지며 감을 익혀요 · 보상 없음</small></div>
      <span className="freethrow-soon">공식 도전 준비 중</span>
    </section>
    <section className="freethrow-board" aria-label="연습 기록">
      <div><small>성공</small><strong>{stats.made}<span>/{stats.shots}</span></strong></div>
      <div><small>성공률</small><strong>{rate}<span>%</span></strong></div>
      <div><small>연속</small><strong>{stats.streak}</strong></div>
      <div><small>최고 연속</small><strong>{stats.best}</strong></div>
    </section>
    {error && <p className="form-message error freethrow-error" role="alert">{error}</p>}
    <div className="freethrow-court" data-mode={mode} data-notouchfx>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img"
        aria-label="정면에서 본 농구 골대와 손에 든 농구공. 공을 아래로 당겼다가 위로 쓸어 올리며 놓으면 슛이 나가요." data-notouchfx />
      <div ref={callout} className={`freethrow-callout ${last?.result.made ? "is-made" : "is-miss"}`} aria-hidden={!copy}>
        {copy && <><strong>{copy.title}</strong>{last!.streak >= 2 && <em>{last!.streak}연속!</em>}</>}
      </div>
      {!thrown && mode === "idle" && <div className="freethrow-coach" aria-hidden="true"><i /><span>당겼다가 위로 슉!</span></div>}
    </div>
    <p className="freethrow-status" role="status" aria-live="polite">{hint || (copy ? copy.detail : "공을 잡고 아래로 살짝 당긴 뒤, 위로 쓸어 올리면서 손을 떼요.")}</p>
    <section className="freethrow-readout card" aria-label="방금 던진 슛">
      <div className="freethrow-meter"><small>세기</small><span className="freethrow-meter-bar"><i style={{ left: `${lastInput?.power ?? 0}%`, opacity: lastInput ? 1 : 0 }} /></span><b>{lastInput ? lastInput.power : "—"}</b></div>
      <div className="freethrow-aim"><small>방향</small><b>{lastInput ? aimLabel(lastInput.aim) : "—"}</b></div>
      <div className="freethrow-recent" aria-label={`최근 ${stats.recent.length}구 중 ${stats.recent.filter(Boolean).length}골`}>
        <small>최근 {FREETHROW_RULES.shotsPerSet}구</small>
        <span>{Array.from({ length: FREETHROW_RULES.shotsPerSet }, (_, i) => {
          const made = stats.recent[i];
          return <i key={i} className={made === undefined ? "" : made ? "is-made" : "is-miss"} />;
        })}</span>
      </div>
    </section>
    <div className="freethrow-tools">
      <button type="button" className="text-button" onClick={reset} disabled={!stats.shots || mode === "flying"}>기록 지우기</button>
      <button type="button" className="freethrow-sound" aria-pressed={!muted} onClick={toggleSound}>소리 {muted ? "꺼짐" : "켜짐"}</button>
    </div>
    <details className="freethrow-guide card"><summary>게임 방법 &amp; 보상</summary><ol>
      <li>공을 누르고 아래로 살짝 당겨 준비해요. 위로 쓸어 올리다가 손을 떼면 슛!</li>
      <li>손을 떼기 직전에 빠를수록 세게 날아가요. 짧으면 더 빠르게, 길면 더 천천히.</li>
      <li>위로 곧게 올리면 가운데로, 기울여 올리면 그쪽으로 빗나가요.</li>
      <li>같은 동작이면 언제나 같은 슛이 나가요. 방금 슛의 세기와 방향을 보고 조절해 보세요.</li>
      <li>PC에서는 마우스로 공을 끌어서 똑같이 던져요.</li>
    </ol>
    <p>연습 모드는 횟수 제한도 보상도 없어요. 공식 도전은 곧 열려요: 한국 시간 {HOURS}시마다 {FREETHROW_RULES.shotsPerSet}구 한 세트, 1골마다 {FREETHROW_RULES.goalScore}점 + {FREETHROW_RULES.goalGold}G를 받아요.</p></details>
  </section>;
}
