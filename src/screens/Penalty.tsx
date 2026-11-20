import { useEffect, useRef, useState } from "react";
import { ARCADE_RULES } from "../../shared/balance";
import { KICK, penaltyKeepers, type KickInput, type KickResult } from "../../shared/penalty-engine";
import { ArcadeScreen, arcadeHours, type ArcadeCopy, type ArcadePlayProps, type ArcadeScreenProps } from "../arcade/screen";
import { createArcadeSound, type ArcadeSound } from "../arcade/sound";
import { PlayProgress, PlayShell, QuitDialog } from "../components/PlayShell";
import { anim, reduced } from "../motion";
import { PenaltyController, type KickMode } from "../penalty/controller";
import { STAGE } from "../penalty/render";
import { SoundIcon } from "./Santa";

const { tries, score, gold } = ARCADE_RULES.penalty;

/** What the player reads after each kick: what happened, then how to adjust. */
export function kickCopy(result: KickResult): { title: string; detail: string } {
  switch (result.kind) {
    case "goal":
      if (result.corner) return { title: "구석에 꽂혔어요!", detail: "골키퍼가 날아도 닿지 않는 자리예요. 지금 그 발, 보험 들어야 해요." };
      if (result.frame) return { title: "골대 맞고 골!", detail: "골대가 잠깐 고민하더니 안쪽으로 보내 줬어요." };
      return { title: "골!", detail: "골키퍼가 닿지 못한 곳으로 들어갔어요." };
    case "saved":
      if (result.input.power < 45) return { title: "막혔어요", detail: "공이 느려서 골키퍼가 여유 있게 따라갔어요. 더 빠르게 쓸어 올려 보세요." };
      return { title: "막혔어요", detail: "골키퍼 손이 닿는 곳이었어요. 골키퍼가 움직이는 반대쪽 구석을 노려 보세요." };
    case "post": return { title: "골대 맞고 나왔어요", detail: result.target.y > 2.3 ? "아주 조금 높았어요. 힘을 살짝만 빼 보세요." : "아주 조금 바깥이었어요. 살짝만 안쪽으로!" };
    case "wide": return { title: `${result.target.x < 0 ? "왼쪽" : "오른쪽"}으로 벗어났어요`, detail: "너무 기울여 찼어요. 골대 안쪽으로 방향을 잡아 보세요." };
    case "over": return { title: "골대 위로 넘어갔어요", detail: "너무 셌어요. 관중석의 누군가가 공을 선물받았어요. 힘을 빼 보세요." };
    case "timeout": return { title: "시간 초과!", detail: `휘슬이 울리고 ${KICK.windowMs / 1000}초 안에 차야 해요.` };
  }
}
const aimLabel = (aim: number) => (aim === 0 ? "가운데" : `${aim < 0 ? "왼쪽" : "오른쪽"} ${Math.abs(aim)}`);

const COPY: ArcadeCopy = {
  title: "승부차기", unit: "골", tries: `킥 ${tries}번`, per: "1골마다",
  practice: "마음껏 차며 골키퍼 읽는 법을 익혀요 · 보상 없음", startLabel: "승부차기 시작하기",
  art: "/penalty/result.webp",
  nothing: "이번엔 골이 없었어요.",
  resultTitle: made => (made === tries ? "5골 전부 성공!" : `${made}골 성공!`),
  resultLine: made => (made >= 4 ? "골키퍼가 조용히 장갑을 벗었어요. 오늘의 기록판을 확인해 보세요!" : made ? "다음엔 한 골 더! 골키퍼가 움직이는 반대쪽을 노려 보세요." : "골키퍼가 오늘 인생 경기를 했어요. 다음 세트에서 만회해요!"),
  guide: <>
    <ol>
      <li>휘슬이 울리면 골키퍼가 좌우로 움직여요. {KICK.windowMs / 1000}초 안에 공을 잡고 차고 싶은 쪽으로 쓸어 올리며 놓으면 슛!</li>
      <li>쓸어 올린 방향으로 날아가요. 너무 기울이면 골대를 벗어나요.</li>
      <li>빠르게 쓸어 올릴수록 공이 빠르고 높게 가요. 너무 세면 골대를 넘기고, 약하면 골키퍼가 여유 있게 막아요.</li>
      <li>골키퍼는 움직이던 쪽으로 몸이 쏠려 있어요. <b>골키퍼가 가는 반대쪽</b>으로 차면 손이 훨씬 덜 닿아요.</li>
      <li>뒤로 갈수록 골키퍼가 더 빠르고 더 멀리 닿아요. 같은 시간대에는 모두 같은 골키퍼 다섯 명을 만나요.</li>
    </ol>
    <p>연습 모드는 횟수 제한도 보상도 없어요. 공식 도전은 한국 시간 {arcadeHours("penalty")}시마다 킥 {tries}번이에요. 시작하면 그 시간의 기회를 쓴 거예요. {tries}번을 다 차면 한 번에 기록되고, 1골마다 {score}점 + {gold}G를 받아요. 중간에 나가면 미완료로 끝나요.</p>
  </>,
};

export function Penalty(props: ArcadeScreenProps) {
  return <ArcadeScreen game="penalty" copy={COPY} {...props} play={play => <PenaltyPlay key={`${play.mode}:${play.slot}`} {...play} />} />;
}

/** The full-screen goal. An official set's kicks stay on the device until the
 * fifth is over; then the whole set is handed over. */
function PenaltyPlay({ mode, slot, onFinish, onQuit }: ArcadePlayProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<PenaltyController | null>(null);
  const sound = useRef<ArcadeSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const inputs = useRef<KickInput[]>([]);
  const marksRef = useRef<boolean[]>([]);
  const finishRef = useRef(onFinish); finishRef.current = onFinish;
  const official = mode === "official";
  const [kickMode, setKickMode] = useState<KickMode>("intro");
  const [marks, setMarks] = useState<boolean[]>([]);
  const [stats, setStats] = useState({ kicks: 0, goals: 0 });
  const [last, setLast] = useState<KickResult | null>(null);
  const [hint, setHint] = useState("");
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const effects = createArcadeSound("yegoom3:penalty:muted");
    sound.current = effects; setMuted(effects.muted);
    // An official set meets its slot's keepers; practice meets new ones every five kicks.
    const keepersFor = () => penaltyKeepers(official ? slot : Math.floor(Math.random() * 0x7fffffff), tries);
    let runtime: PenaltyController;
    try {
      runtime = new PenaltyController(canvas.current!, effects, {
        onMode: setKickMode,
        onKick: input => { inputs.current.push(input); setHint(""); },
        onCancel: () => setHint("공을 잡고 차고 싶은 쪽으로 빠르게 쓸어 올리며 놓아요."),
        onResult: result => {
          marksRef.current = [...marksRef.current, result.made]; setMarks(marksRef.current);
          setStats(value => ({ kicks: value.kicks + 1, goals: value.goals + Number(result.made) }));
          setLast(result);
          if (result.made) effects.cheer(result.corner ? 2 : 1); else effects.sad();
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
          if (official && marksRef.current.length === tries) finishRef.current(inputs.current.slice(0, tries), marksRef.current.filter(Boolean).length);
        },
      }, keepersFor, !official);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "경기장을 표시하지 못했어요."); return; }
    controller.current = runtime;
    const warmUp = window.setTimeout(() => effects.prepare(), 120);
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { clearTimeout(warmUp); runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, [official, slot]);
  const done = official && marks.length >= tries;
  // The last kick's ball and keeper keep moving behind the result; the controller stops by itself.
  const running = visible && !confirming;
  useEffect(() => { controller.current?.setEnabled(running); }, [running]);

  function askQuit() {
    if (!official || done) { onQuit(); return; }
    setConfirming(true);
  }
  function toggleSound() { const next = !muted; sound.current?.setMuted(next); setMuted(next); }
  const copy = last ? kickCopy(last) : null;
  const shown = copy && (kickMode === "after" || kickMode === "over");
  const lastInput = last && last.kind !== "timeout" ? last.input : null;
  const rate = stats.kicks ? Math.round((stats.goals / stats.kicks) * 100) : 0;
  const current = official ? marks.length : marks.length % tries;
  return <PlayShell label={official ? "승부차기 공식 도전" : "승부차기 연습"} theme={{ background: "#2f8f5b", text: "#fff", tone: "dark" }} onClose={askQuit}
    top={official ? <PlayProgress marks={marks} total={tries} current={done ? null : current} label="찬 킥" />
      : <div className="arcade-practice-stats is-dark" aria-label="연습 기록"><strong>연습</strong><span>골 <b>{stats.goals}/{stats.kicks}</b></span><span>{rate}%</span><span>골키퍼 <b>{current + 1}</b>번</span></div>}
    right={<button type="button" className="play-icon-button" aria-pressed={!muted} aria-label={muted ? "소리 켜기" : "소리 끄기"} onClick={toggleSound}><SoundIcon muted={muted} /></button>}
    stage={{ width: STAGE.width, height: STAGE.height, content: <div className="arcade-stage" data-mode={kickMode}>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img"
        aria-label="공 뒤에서 바라본 골대와 좌우로 움직이는 골키퍼. 공을 잡고 차고 싶은 쪽으로 쓸어 올리며 놓으면 슛이 나가요." />
      <div ref={callout} className={`arcade-callout ${last?.made ? "is-made" : "is-miss"}`} aria-hidden={!shown}>
        {shown && <strong>{copy.title}</strong>}
      </div>
      {kickMode === "intro" && !done && <div className="arcade-callout is-miss" aria-live="polite"><strong>{official ? `${current + 1}번째 킥` : "준비…"}</strong></div>}
      {!stats.kicks && (kickMode === "aiming" || kickMode === "holding") && <div className="arcade-coach" aria-hidden="true">골키퍼 반대쪽으로 슉!</div>}
      {done && <div className="arcade-lock"><span>승부차기 끝!</span></div>}
      {error && <p className="arcade-play-error" role="alert">{error}</p>}
    </div> }}
    bottom={<>
      <p className="arcade-status is-dark" role="status" aria-live="polite">{hint || (shown ? copy.detail : "휘슬이 울리면 공을 잡고, 골키퍼가 가는 반대쪽으로 쓸어 올리며 손을 떼요.")}</p>
      <div className="arcade-readout" aria-label="방금 찬 킥">
        <div className="arcade-meter"><small>세기</small><span className="arcade-meter-bar"><i style={{ left: `${lastInput?.power ?? 0}%`, opacity: lastInput ? 1 : 0 }} /></span><b>{lastInput ? lastInput.power : "—"}</b></div>
        <div className="arcade-aim"><small>방향</small><b>{lastInput ? aimLabel(lastInput.aim) : "—"}</b></div>
      </div>
    </>}>
    {confirming && <QuitDialog title="승부차기를 그만둘까요?" detail="지금 나가면 이번 세트는 미완료로 끝나요. 점수와 골드를 받지 못하고, 이번 시간에는 다시 시작할 수 없어요."
      stay="계속 차기" onStay={() => setConfirming(false)} onQuit={() => { setConfirming(false); onQuit(); }} />}
  </PlayShell>;
}
