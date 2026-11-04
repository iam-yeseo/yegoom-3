import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CLAW_RULES } from "../../shared/balance";
import { DOLL_COUNT, DOLL_TYPES } from "../../shared/claw-physics";
import type { ClawResult, User } from "../../shared/types";
import { useClaw } from "../claw-state";
import { Avatar, Coin, Toolbar } from "../components/UI";
import { anim, openSheet, reduced, toast } from "../motion";
import { ClawController, initialView } from "../claw/controller";
import { dollSrc } from "../claw/render";
import "../preview.css";
import "../claw/claw.css";

const refillHours = Array.from({ length: Math.ceil(24 * 60 * 60 * 1000 / CLAW_RULES.coinIntervalMs) }, (_, i) => String(i * CLAW_RULES.coinIntervalMs / (60 * 60 * 1000)).padStart(2, "0")).join("·");

function resultCopy(result: ClawResult, admin: boolean) {
  const won = result.prizes;
  const cleared = result.cleared ?? Boolean(result.clearBonus);
  const dropped = result.reason === "lift-drop" || result.reason === "travel-drop";
  const close = result.reason === "travel-drop" && result.released && result.released.x < .35;
  return {
    eyebrow: cleared ? "ALL CLEAR!" : won.length > 1 ? "DOUBLE CATCH!" : won.length ? "GOOD CATCH!" : close ? "SO CLOSE!" : "ONE MORE TRY!",
    title: cleared ? `${DOLL_COUNT}개 모두 뽑았어요!` : won.length > 1 ? `한 번에 ${won.length}개!` : won.length ? "인형 뽑기 성공!"
      : result.reason === "lift-drop" ? "들어 올리다 미끄러졌어요" : result.reason === "travel-drop" ? (close ? "아깝다, 배출구 바로 앞!" : "옮기다가 떨어졌어요") : "조금만 더 가까이!",
    description: admin ? cleared ? "모든 인형을 뽑았어요! 새 기계를 준비했어요. 운영자 테스트는 보상 없이 진행해요."
      : "운영자 테스트는 점수·골드 보상이 없고 랭킹과 내역에도 반영되지 않아요."
      : cleared ? `마지막 인형에 클리어 보너스 ${CLAW_RULES.clearScore}점과 ${CLAW_RULES.clearGold}G까지! 새 친구들을 채워둘게요.`
      : won.length > 1 ? "옮기던 인형과 걸쳐 있던 인형이 함께 굴러 들어갔어요. 모두 점수로 기록했어요."
      : won.length ? "귀여운 친구를 무사히 데려왔어요. 랭킹에도 점수를 기록했어요."
      : dropped ? "떨어진 인형은 그 자리에 그대로 남아요. 배출구 쪽으로 옮겨 놓았다면 다음 판에 노려 보세요!"
      : result.stop !== null ? "집게를 너무 일찍 멈췄을지도 몰라요. 인형의 가운데를 깊숙이 감싸야 해요."
      : "집게가 인형을 제대로 감싸지 못했어요. 옆 인형에 집게발이 걸리지 않는 자리를 노려 보세요.",
  };
}
function ResultDialog({ result, message, user, demo, onClose }: { result: ClawResult; message: string; user: User; demo: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const particles = useRef<HTMLDivElement>(null);
  const admin = user.role === "admin";
  const copy = resultCopy(result, admin);
  const won = result.prizes.length > 0;
  useEffect(() => {
    const node = dialog.current!;
    const closeSheet = openSheet(node);
    // Particles stay inside this native dialog's top layer.
    const effects = !reduced() ? Array.from(particles.current?.children ?? []).map((particle, i) => {
      const angle = (Math.PI * 2 * i) / 12;
      return anim(particle, [{ transform: "translate(0,0) scale(.4)", opacity: 1 },
        { transform: `translate(${Math.cos(angle) * 100}px,${Math.sin(angle) * 70 - 25}px) rotate(${i * 30}deg) scale(1)`, opacity: 1, offset: .45 },
        { transform: `translate(${Math.cos(angle) * 115}px,${Math.sin(angle) * 70 + 55}px) rotate(${i * 50}deg) scale(.8)`, opacity: 0 }], { dur: 1100 });
    }) : [];
    return () => { effects.forEach(effect => effect?.cancel()); closeSheet(); };
  }, []);
  return <dialog className="claw-result" ref={dialog} aria-labelledby="claw-result-title" aria-describedby="claw-result-description" onCancel={event => event.preventDefault()}>
    <div className={`claw-result-art ${result.prizes.length > 1 ? "is-many" : ""}`}>
      {won ? result.prizes.slice(0, 3).map(doll => <img key={doll.id} src={dollSrc(doll.type)} alt={`뽑은 인형 ${doll.type}번`} />)
        : <Avatar username={user.username} artKey={demo ? undefined : user.character ?? undefined} size={116} />}
      {won && !reduced() && <div className="claw-result-confetti" ref={particles} aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>}
    </div>
    <small className="claw-result-eyebrow">{copy.eyebrow}</small>
    <h2 id="claw-result-title">{copy.title}</h2>
    <p id="claw-result-description">{copy.description}</p>
    {admin ? <p className="claw-admin-no-reward">보상 없음 · 운영자 테스트</p> : won && <div className="claw-result-rewards"><strong>+{result.points}점</strong><strong>+{result.gold}G</strong></div>}
    {Boolean(result.clearBonus) && <p className="claw-clear-bonus">클리어 보너스 +{result.clearBonus}점 · +{result.clearGold}G 포함</p>}
    {message && <p role="status">{message}</p>}
    <button className="primary-button" type="button" onClick={onClose}>확인</button>
  </dialog>;
}
function SoundIcon({ muted }: { muted: boolean }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4 6 8H3v8h3l5 4V4Z" />{muted ? <path d="m16 9 5 6m0-6-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8" /><path d="M18 5a10 10 0 0 1 0 14" /></>}
  </svg>;
}

export function Claw({ user, onBack, demo = false }: { user: User; onBack: () => void; demo?: boolean }) {
  const game = useClaw();
  const latest = useRef(game); latest.current = game;
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<ClawController | null>(null);
  const [view, setView] = useState(initialView);
  const [localError, setLocalError] = useState("");
  const [buying, setBuying] = useState(false);
  const purchaseLock = useRef(false);
  const refillAttempt = useRef<number | null>(null);
  useEffect(() => {
    let runtime: ClawController;
    try { runtime = new ClawController(canvas.current!, () => latest.current, setView); controller.current = runtime; }
    catch (error) { setLocalError(error instanceof Error ? error.message : "기계를 표시하지 못했어요."); return; }
    void latest.current.load().catch(() => {});
    const release = () => runtime.releaseAll();
    const visibility = () => { release(); if (!document.hidden && runtime.idle) void latest.current.load().catch(() => {}); };
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (document.querySelector("dialog:modal") || target?.closest("input,textarea,select,[contenteditable]")) return;
      const direction = event.key === "ArrowLeft" ? "left" : event.key === "ArrowRight" ? "right" : null;
      if (direction) { event.preventDefault(); if (!event.repeat) runtime.press(direction); }
      if (event.code === "Space" && target?.tagName !== "BUTTON" && target?.tagName !== "SUMMARY") { event.preventDefault(); if (!event.repeat) runtime.primary(); }
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === "ArrowLeft") runtime.release("left"); if (event.key === "ArrowRight") runtime.release("right"); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      runtime.destroy(); controller.current = null;
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => { controller.current?.sync(); }, [game.state, game.pendingPlay, game.error]);
  // A local clock updates the label; the network is touched only once per refill boundary.
  useEffect(() => {
    const next = game.state?.nextGrantAt;
    if (game.state?.isAdmin || !next || view.now < next || document.hidden || view.mode !== "idle" || game.busy || game.loading || game.pendingPlay || game.pendingPurchase || refillAttempt.current === next) return;
    refillAttempt.current = next;
    void game.load().catch(() => {});
  }, [view.now, view.mode, game.state?.nextGrantAt, game.state?.isAdmin, game.busy, game.loading, game.pendingPlay, game.pendingPurchase, game.load]);
  const state = game.state;
  const admin = user.role === "admin" || state?.isAdmin;
  const idle = view.mode === "idle";
  const cooling = Math.max(0, (state?.nextPlayAt ?? 0) - view.now);
  const seconds = Math.max(0, Math.ceil(((state?.nextGrantAt ?? view.now) - view.now) / 1000));
  const refill = state ? seconds ? `다음 충전까지 ${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}시간 ` : ""}${Math.floor(seconds % 3600 / 60)}분 ${String(seconds % 60).padStart(2, "0")}초` : "충전 확인 중…" : "코인을 확인하고 있어요";
  const primaryLabel = view.mode === "ready" ? "집게 내리기" : view.mode === "descending" ? "멈추기" : !idle ? "뽑는 중…" : game.pendingPlay ? "결과 확인" : admin ? "테스트 시작" : "코인 넣기";
  const primaryDisabled = Boolean((!state && !game.pendingPlay) || game.busy || buying || game.pendingPurchase || localError || (idle ? !game.pendingPlay && ((!admin && (state?.coins ?? 0) < 1) || cooling > 0 || game.loading) : !["ready", "descending"].includes(view.mode)));
  const buyDisabled = Boolean(admin || !state || !idle || game.busy || game.loading || buying || game.pendingPlay || game.pendingPurchase);
  async function buy(quantity: 1 | 5) {
    if (purchaseLock.current || !idle || admin) return;
    purchaseLock.current = true; setBuying(true);
    try { await game.buy(quantity); toast(`코인 ${quantity}개를 샀어요`); } catch { /* Provider exposes a recoverable error. */ }
    finally { purchaseLock.current = false; setBuying(false); }
  }
  function hold(direction: "left" | "right", event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.disabled || !event.isPrimary || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); controller.current?.press(direction);
  }
  return <section className="preview-game pg-claw claw-page">
    <Toolbar title="캐릭터 뽑기" onBack={onBack} gold={user.gold} />
    <section className="claw-wallet card" aria-label={admin ? "운영자 테스트" : "내 코인"}>
      {admin ? <div className="claw-admin-wallet"><div><small>운영자 테스트</small><strong>무제한</strong></div><p>코인 차감 없이 플레이해요.<br />점수·골드 보상 없음</p></div> : <><div className="claw-wallet-heading"><Coin size={34} /><div><small>내 코인</small><strong>{state?.coins ?? "—"}<span>개</span></strong></div><div className="claw-wallet-detail"><span>무료 {state?.freeCoins ?? "—"}개 · 구매 {state?.purchasedCoins ?? "—"}개</span><small>{refill}</small></div></div>
      <div className="claw-coin-purchases">{CLAW_RULES.purchaseQuantities.map(quantity => <button type="button" key={quantity} disabled={buyDisabled || user.gold < quantity * CLAW_RULES.coinPrice} onClick={() => void buy(quantity)}>코인 {quantity}개 사기 · {quantity * CLAW_RULES.coinPrice}G</button>)}</div>
      {game.pendingPurchase && <button className="text-button" disabled={game.busy || buying || !idle} onClick={() => void buy(game.pendingPurchase!.input.quantity)}>구매 결과 확인</button>}</>}
      {admin && <label className="claw-admin-force"><input type="checkbox" checked={game.pendingPlay?.input.forceStrong ?? game.forceStrong} onChange={event => game.setForceStrong(event.target.checked)} disabled={!state || !idle || game.busy || game.loading || Boolean(game.pendingPlay)} />이번 판 강집게로</label>}
    </section>
    {(game.error || localError) && <div className="claw-error"><p className="form-message error" role="alert">{localError || game.error}</p>{!game.pendingPlay && !game.pendingPurchase && <button className="text-button" disabled={game.loading || game.busy || !idle} onClick={() => void game.load().catch(() => {})}>기계 다시 확인</button>}</div>}
    <section className={`pg-machine claw-cabinet ${view.flashing ? "is-celebrating" : ""}`} aria-label="캐릭터 뽑기 기계" data-state={view.mode}>
      <div className="claw-marquee"><span className="claw-bulbs" aria-hidden="true"><i /><i /><i /></span><div className="claw-sign"><small>YEGOOM ARCADE</small><strong>예굼 인형뽑기</strong></div><span className="claw-bulbs" aria-hidden="true"><i /><i /><i /></span></div>
      <div className="claw-glass" data-notouchfx><div className="claw-glass-meta"><span>PRIZE OUT ↙</span><span>인형 {view.dolls}개</span></div><canvas ref={canvas} width={600} height={420} role="img" aria-label={`왼쪽에 배출구, 오른쪽에 인형 ${view.dolls}개가 쌓인 인형뽑기 기계. 집게 위치는 왼쪽에서 ${Math.round(view.x * 100)}퍼센트입니다.`} data-notouchfx /></div>
      <div className="claw-console" data-notouchfx data-nopress>
        <div className="claw-directions" role="group" aria-label="집게 좌우 이동">{(["left", "right"] as const).map(direction => <button className={`claw-arrow ${view.held.includes(direction) ? "is-held" : ""}`} key={direction} type="button" aria-label={`집게 ${direction === "left" ? "왼쪽" : "오른쪽"}으로 이동`} disabled={view.mode !== "ready"} onPointerDown={event => hold(direction, event)} onPointerUp={() => controller.current?.release(direction)} onPointerCancel={() => controller.current?.release(direction)} onLostPointerCapture={() => controller.current?.release(direction)} data-notouchfx>{direction === "left" ? "◀" : "▶"}</button>)}</div>
        <div className="claw-timer" role="timer" aria-label="남은 시간(초)"><small>TIME</small><b className={view.mode === "ready" && view.timer <= 5 ? "is-urgent" : ""}>{view.mode === "idle" || view.mode === "ready" ? String(view.timer).padStart(2, "0") : "--"}</b></div>
        <button className={`claw-drop ${["ready", "descending"].includes(view.mode) ? "is-armed" : ""}`} type="button" aria-label={primaryLabel} disabled={primaryDisabled} onClick={() => controller.current?.primary()} data-notouchfx><span>{primaryLabel}</span><small>{view.mode === "ready" ? "DROP" : view.mode === "descending" ? "STOP" : game.pendingPlay && idle ? "RETRY" : cooling > 0 && idle ? `${Math.ceil(cooling / 1000)}초 뒤 다시` : admin ? "TEST PLAY" : "1 COIN"}</small></button>
      </div>
      <div className="claw-base" aria-hidden="true"><span>✦</span><span className="claw-slot">{admin ? "TEST ▼" : "COIN ▼"}{view.insertion > 0 && <i key={view.insertion} />}</span><span>✦</span></div>
    </section>
    <p className="claw-status" role="status" aria-live="polite">{view.status}</p>
    <div className="claw-key-hint"><p>PC <kbd>←</kbd> <kbd>→</kbd> 이동 · <kbd>Space</kbd> {admin ? "시작" : "코인"} · 내리기 · 멈추기</p><button type="button" className="claw-sound" aria-pressed={!view.muted} onClick={() => controller.current?.toggleSound()}><SoundIcon muted={view.muted} />소리 {view.muted ? "꺼짐" : "켜짐"}</button></div>
    <details className="claw-guide card"><summary>게임 규칙 &amp; 보상</summary><ol>
      <li>{admin ? "테스트를 시작하면" : "코인을 넣으면"} {CLAW_RULES.controlDurationMs / 1000}초 안에 ◀ ▶ 버튼으로 집게를 옮겨요. 시간이 다 되면 그 자리에서 내려가요.</li>
      <li>{admin ? "운영자 테스트에서는 코인을 쓰지 않아요." : "집게 내리기를 누르면 1코인을 써요."} 내려가는 중에 한 번 더 누르면 그 높이에서 멈춰 집어요.</li>
      <li>인형 가운데를 깊숙이 감싸야 잘 잡혀요. 옆 인형에 집게발이 걸리지 않는 자리를 노려 보세요.</li>
      <li>집게 힘은 판마다 달라요. 크고 무거운 인형은 더 잘 미끄러져요. 떨어진 인형은 그 자리에 남아요.</li>
    </ol>{admin ? <p>운영자 전용 기계로 무제한 테스트할 수 있어요. 보상과 당첨 소식은 생기지 않으며, 인형을 모두 뽑으면 새 기계가 준비돼요.</p> : <><p>무료 코인은 한국 시간 {refillHours}시마다 {CLAW_RULES.freeCoins}개로 채워져요. 남은 코인은 이월되지 않아요. 구매 코인은 계속 보관하고 무료 코인부터 사용해요.</p><p>인형 1개마다 {CLAW_RULES.dollScore}점 + {CLAW_RULES.dollGold}G! 한 번에 여러 개가 굴러 들어가면 모두 보상받아요. {DOLL_TYPES}종 중 무작위로 채운 {DOLL_COUNT}개를 모두 뽑으면 추가 {CLAW_RULES.clearScore}점 + {CLAW_RULES.clearGold}G와 새 기계가 준비돼요.</p></>}</details>
    {view.result && <ResultDialog key={view.result.requestId} result={view.result} message={view.replayMessage} user={user} demo={demo} onClose={() => controller.current?.finish()} />}
  </section>;
}
