import { useEffect, useRef, useState } from "react";
import { ARCADE_RULES } from "../../shared/balance";
import { inHouse, type StoneInput, type StonePosition, type ThrowResult } from "../../shared/curling-physics";
import { ArcadeScreen, arcadeHours, type ArcadeCopy, type ArcadePlayProps, type ArcadeScreenProps } from "../arcade/screen";
import { createArcadeSound, type ArcadeSound } from "../arcade/sound";
import { PlayProgress, PlayShell, QuitDialog } from "../components/PlayShell";
import { CurlingController, type SheetMode } from "../curling/controller";
import { STAGE } from "../curling/render";
import { anim, reduced } from "../motion";
import { SoundIcon } from "./Santa";

const { tries, score, gold } = ARCADE_RULES.curling;

/** What the player reads after each stone: what happened, then how to adjust. */
export function stoneCopy(result: ThrowResult): { title: string; detail: string; good: boolean } {
  const bump = result.knocked ? " 그런데 하우스에 있던 내 스톤을 밀어냈어요." : "";
  switch (result.kind) {
    case "button": return { title: "버튼에 딱!", detail: `하우스 한가운데예요. 해설자가 있었다면 지금 소리 질렀어요.${bump}`, good: true };
    case "house": return { title: "하우스 안착!", detail: `끝날 때까지 하우스에 남아 있으면 1점이에요.${bump}`, good: true };
    case "guard": return result.hits
      ? { title: "스톤에 부딪혀 멈췄어요", detail: `앞에 있던 스톤에 막혔어요. 방향을 옮겨서 비켜 가 보세요.${bump}`, good: false }
      : { title: "하우스 앞에 멈췄어요", detail: "조금 약했어요. 살짝만 더 빠르게 밀어 보세요. 이 스톤은 길을 막는 가드가 됐어요.", good: false };
    case "wide": return { title: "하우스 옆에 멈췄어요", detail: `거리는 좋았는데 방향이 비켜났어요. 가운데 쪽으로 옮겨 보세요.${bump}`, good: false };
    case "short": return { title: "호그 라인을 못 넘었어요", detail: "너무 약해서 스톤을 치웠어요. 더 빠르게 밀어 올려 보세요.", good: false };
    case "long": return { title: "하우스를 지나쳤어요", detail: `너무 셌어요. 힘을 빼고 조금 천천히 밀어 보세요.${bump}`, good: false };
    case "out": return { title: "옆 벽에 닿았어요", detail: `방향이 너무 기울었어요. 벽에 닿은 스톤은 치워져요.${bump}`, good: false };
  }
}
const aimLabel = (aim: number) => (aim === 0 ? "가운데" : `${aim < 0 ? "왼쪽" : "오른쪽"} ${Math.abs(aim)}`);

const COPY: ArcadeCopy = {
  title: "컬링", unit: "개", tries: `스톤 ${tries}개`, per: "하우스 스톤 1개마다",
  practice: "마음껏 밀며 얼음 감을 익혀요 · 보상 없음", startLabel: "엔드 시작하기",
  nothing: "하우스에 남은 스톤이 없었어요.",
  resultTitle: made => (made === tries ? "퍼펙트 엔드!" : `스톤 ${made}개 안착!`),
  resultLine: made => (made >= 4 ? "얼음을 읽는 눈이 생겼어요. 오늘의 기록판을 확인해 보세요!" : made ? "다음 엔드에서는 하나 더! 연습 모드로 힘 조절을 다듬어 보세요." : "스톤들이 전부 산책을 나갔어요. 다음 엔드에서 만회해요!"),
  guide: <>
    <ol>
      <li>얼음 위를 누르거나 끌어서 <b>방향</b>을 먼저 정해요. 점선이 스톤이 나갈 방향이에요. 아래 ◀ ▶ 로 조금씩 옮길 수도 있어요.</li>
      <li>스톤을 잡고 위로 쓸어 올리다가 손을 떼면 밀려 나가요. 손을 떼기 직전에 빠를수록 멀리 가요.</li>
      <li>스톤은 그대로 남아요. 먼저 놓은 스톤이 길을 막기도 하고, 부딪혀서 밀려나기도 해요.</li>
      <li>호그 라인(빨간 선)을 못 넘거나, 뒤로 지나가거나, 옆 벽에 닿은 스톤은 치워져요.</li>
      <li>스톤 {tries}개를 다 민 뒤 하우스(동그란 과녁)에 조금이라도 걸쳐 있는 스톤 수가 점수예요.</li>
    </ol>
    <p>연습 모드는 횟수 제한도 보상도 없어요. 공식 도전은 한국 시간 {arcadeHours("curling")}시마다 한 엔드예요. 시작하면 그 시간의 기회를 쓴 거예요. 스톤 {tries}개를 다 밀면 한 번에 기록되고, 하우스에 남은 스톤 1개마다 {score}점 + {gold}G를 받아요. 중간에 나가면 미완료로 끝나요.</p>
  </>,
};

export function Curling(props: ArcadeScreenProps) {
  return <ArcadeScreen game="curling" copy={COPY} {...props} play={play => <CurlingPlay key={`${play.mode}:${play.slot}`} {...play} />} />;
}

/** The full-screen sheet. An official end's throws stay on the device until
 * the last stone stops; then the whole end is handed over. */
function CurlingPlay({ mode, onFinish, onQuit }: ArcadePlayProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<CurlingController | null>(null);
  const sound = useRef<ArcadeSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const inputs = useRef<StoneInput[]>([]);
  const finishRef = useRef(onFinish); finishRef.current = onFinish;
  const official = mode === "official";
  const [sheetMode, setSheetMode] = useState<SheetMode>("ready");
  const [aim, setAim] = useState(0);
  const [sheet, setSheet] = useState<StonePosition[]>([]);
  const [thrown, setThrown] = useState(0);
  const [last, setLast] = useState<ThrowResult | null>(null);
  const [lastInput, setLastInput] = useState<StoneInput | null>(null);
  const [hint, setHint] = useState("");
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const effects = createArcadeSound("yegoom3:curling:muted");
    sound.current = effects; setMuted(effects.muted);
    let runtime: CurlingController;
    try {
      runtime = new CurlingController(canvas.current!, effects, {
        onMode: setSheetMode, onAim: setAim,
        onThrow: input => { inputs.current.push(input); setLastInput(input); setHint(""); },
        onCancel: () => setHint("스톤을 잡고 위로 빠르게 쓸어 올리며 놓아요."),
        onResult: (result, left) => {
          setSheet(left); setLast(result); setThrown(inputs.current.length);
          const copy = stoneCopy(result);
          if (copy.good) effects.cheer(result.kind === "button" ? 2 : 0); else effects.sad();
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
          if (official && inputs.current.length === tries) finishRef.current(inputs.current.slice(0, tries), left.filter(inHouse).length);
        },
      }, tries);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "시트를 표시하지 못했어요."); return; }
    controller.current = runtime;
    const warmUp = window.setTimeout(() => effects.prepare(), 120);
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { clearTimeout(warmUp); runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, [official]);
  const over = thrown >= tries;
  const throwable = visible && !confirming && !over;
  useEffect(() => { controller.current?.setEnabled(throwable); }, [throwable]);

  function askQuit() {
    if (!official || over) { onQuit(); return; }
    setConfirming(true);
  }
  function again() {
    inputs.current = []; setSheet([]); setThrown(0); setLast(null); setLastInput(null); setHint("");
    controller.current?.reset();
  }
  function toggleSound() { const next = !muted; sound.current?.setMuted(next); setMuted(next); }
  const nudge = (step: number) => controller.current?.setAim(aim + step);
  const copy = last ? stoneCopy(last) : null;
  const housed = sheet.filter(inHouse).length;
  // Each thrown stone is marked by whether it lies in the house right now.
  const marks = Array.from({ length: thrown }, (_, id) => sheet.some(stone => stone.id === id && inHouse(stone)));
  const waiting = sheetMode === "ready" || sheetMode === "holding";
  return <PlayShell label={official ? "컬링 공식 도전" : "컬링 연습"} theme={{ background: "#dcecf4", text: "#3a3340", tone: "light" }} onClose={askQuit}
    top={official ? <PlayProgress marks={marks} total={tries} current={over ? null : thrown} label="민 스톤" />
      : <div className="arcade-practice-stats" aria-label="연습 기록"><strong>연습</strong><span>스톤 <b>{Math.min(thrown + 1, tries)}/{tries}</b></span><span>하우스 <b>{housed}</b></span></div>}
    right={<button type="button" className="play-icon-button" aria-pressed={!muted} aria-label={muted ? "소리 켜기" : "소리 끄기"} onClick={toggleSound}><SoundIcon muted={muted} /></button>}
    stage={{ width: STAGE.width, height: STAGE.height, content: <div className="arcade-stage" data-mode={sheetMode}>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img"
        aria-label="위에서 내려다본 컬링 시트. 얼음을 눌러 방향을 정하고, 아래의 스톤을 위로 쓸어 올리며 놓으면 하우스를 향해 미끄러져요." />
      <div ref={callout} className={`arcade-callout ${copy?.good ? "is-made" : "is-miss"}`} aria-hidden={!copy || !waiting && !over}>
        {copy && sheetMode !== "sliding" && <strong>{copy.title}</strong>}
      </div>
      {!thrown && waiting && <div className="arcade-coach" aria-hidden="true">방향을 정하고, 스톤을 위로 슉!</div>}
      {over && official && <div className="arcade-lock"><span>엔드 끝! 하우스에 {housed}개</span></div>}
      {over && !official && <div className="arcade-again"><strong>이번 엔드 {housed}개 안착</strong>
        <button type="button" className="primary-button" onClick={again}>한 엔드 더</button></div>}
      {error && <p className="arcade-play-error" role="alert">{error}</p>}
    </div> }}
    bottom={<>
      <p className="arcade-status" role="status" aria-live="polite">{hint || (copy ? copy.detail : "얼음을 눌러 방향을 정한 뒤, 스톤을 잡고 위로 쓸어 올리면서 손을 떼요.")}</p>
      <div className="arcade-readout-row">
        <button type="button" className="arcade-nudge" aria-label="방향을 왼쪽으로" disabled={!waiting || over} onClick={() => nudge(-3)}>◀</button>
        <div className="arcade-readout" aria-label="방향과 방금 민 세기">
          <div className="arcade-meter"><small>방금 세기</small><span className="arcade-meter-bar"><i style={{ left: `${lastInput?.power ?? 0}%`, opacity: lastInput ? 1 : 0 }} /></span><b>{lastInput ? lastInput.power : "—"}</b></div>
          <div className="arcade-aim"><small>방향</small><b>{aimLabel(aim)}</b></div>
        </div>
        <button type="button" className="arcade-nudge" aria-label="방향을 오른쪽으로" disabled={!waiting || over} onClick={() => nudge(3)}>▶</button>
      </div>
    </>}>
    {confirming && <QuitDialog title="엔드를 그만둘까요?" detail="지금 나가면 이번 엔드는 미완료로 끝나요. 점수와 골드를 받지 못하고, 이번 시간에는 다시 시작할 수 없어요."
      stay="계속 밀기" onStay={() => setConfirming(false)} onQuit={() => { setConfirming(false); onQuit(); }} />}
  </PlayShell>;
}
