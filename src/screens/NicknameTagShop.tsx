import { useEffect, useRef, useState } from "react";
import { NICKNAME_TAG_RULES } from "../../shared/balance";
import { TAG_GRADES, gradeLabel } from "../../shared/nickname-tags";
import type { NicknameTag, TagDrawInput } from "../../shared/types";
import { NickTag, Toolbar, honorific, useDisplayName } from "../components/UI";
import { confetti, flipY, openSheet, reduced, toast, useCountUp } from "../motion";
import { useShop } from "../shop";

/** The drawn tag, with a shortcut to wear it right away. */
function DrawResult({ tag, name, drawsToday, busy, onEquip, onClose }: {
  tag: NicknameTag; name: string; drawsToday: number; busy: boolean; onEquip: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = openSheet(dialog.current!);
    flipY(chip.current, { delay: 300 });
    if (!reduced() && (tag.grade === "S" || tag.grade === "A")) confetti(chip.current, { spread: 140 });
    return close;
  }, [tag.grade]);
  return <dialog className="color-picker-dialog tag-draw-dialog" ref={dialog} aria-labelledby="tag-draw-title"
    onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <div className={`tag-draw-sheet grade-${tag.grade.toLowerCase()}`}>
      <span className="sheet-handle" aria-hidden="true" />
      <h2 id="tag-draw-title" className="sr-only">새 별명 태그를 뽑았어요</h2>
      <small className="tag-draw-grade">{gradeLabel(tag.grade)}</small>
      <div className="tag-draw-card" ref={chip}><NickTag tag={tag} /><strong>{name}</strong></div>
      <p className="tag-draw-meta">-{NICKNAME_TAG_RULES.price.toLocaleString("ko-KR")}G · 오늘 {drawsToday}/{NICKNAME_TAG_RULES.dailyLimit}회</p>
      {tag.equipped && <p className="tag-note">지금 달고 있어요.</p>}
      <div className="tag-draw-actions">
        <button type="button" className="secondary-button" onClick={() => dialog.current?.close()}>닫기</button>
        {!tag.equipped && <button type="button" className="primary-button" disabled={busy} onClick={onEquip}>{busy ? "다는 중…" : "지금 달기"}</button>}
      </div>
    </div>
  </dialog>;
}

export function NicknameTagShop({ username, displayName, onBack, go }: {
  username: string; displayName?: string; onBack: () => void; go: (path: string) => void;
}) {
  const shop = useShop();
  const name = honorific(useDisplayName(username, displayName));
  const latest = useRef(shop);
  latest.current = shop;
  const shownGold = useCountUp(shop.gold);
  const [busy, setBusy] = useState(false);
  const [equipping, setEquipping] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NicknameTag | null>(null);
  useEffect(() => { void latest.current.refresh("tag").catch(() => {}); }, []);
  const tags = shop.tags;
  const pending = shop.pending?.kind === "tag" ? shop.pending.input as TagDrawInput : null;
  const drawsToday = tags?.drawsToday ?? 0;
  const left = NICKNAME_TAG_RULES.dailyLimit - drawsToday;
  const canDraw = Boolean(tags) && shop.canPurchase && !busy && !shop.loading && (!shop.pending || Boolean(pending))
    && (Boolean(pending) || (left > 0 && shop.gold >= NICKNAME_TAG_RULES.price));
  async function draw() {
    if (!canDraw) return;
    setBusy(true);
    setError("");
    try {
      const next = await shop.drawTag(pending ?? { requestId: crypto.randomUUID() });
      if (next.draw) setResult(next.draw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "별명 태그를 뽑지 못했어요. 같은 버튼으로 다시 확인해 주세요.");
    } finally { setBusy(false); }
  }
  async function equip(tag: NicknameTag) {
    setEquipping(true);
    try {
      await shop.equipTag(tag.id);
      setResult({ ...tag, equipped: true });
      toast("별명 태그를 달았어요");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "별명 태그를 달지 못했어요.");
    } finally { setEquipping(false); }
  }
  return <div className="tag-shop">
    <Toolbar title="별명 태그 뽑기" onBack={onBack} gold={shownGold} />
    <div className="screen-body stack">
      <section className="card tag-shop-hero">
        <div className="tag-shop-sample" aria-hidden="true">
          <NickTag tag={{ grade: "S", text: "전설적인" }} /><NickTag tag={{ grade: "A", text: "반짝이는" }} />
          <NickTag tag={{ grade: "B", text: "느긋한" }} /><NickTag tag={{ grade: "C", text: "배가 고픈" }} />
        </div>
        <p>뽑은 태그는 내 정보에서 골라 달 수 있어요.<br />단 태그는 앱 어디서든 내 닉네임 앞에 보여요.</p>
        <div className="tag-shop-odds" aria-label="등급별 확률">
          {TAG_GRADES.map(grade => <div key={grade.grade} className={`grade-${grade.grade.toLowerCase()}`}><strong>{grade.label}</strong><span>{grade.look}</span><small>{grade.chance}%</small></div>)}
        </div>
      </section>
      <div className="shop-purchase-actions slot-purchase-actions">
        {shop.canPurchase && !pending && left <= 0 && <p className="subtle-note">오늘은 모두 뽑았어요. 내일 다시 뽑을 수 있어요.</p>}
        {shop.canPurchase && !pending && left > 0 && shop.gold < NICKNAME_TAG_RULES.price && <p className="subtle-note">골드가 부족해요.</p>}
        <button type="button" className="primary-button" disabled={!canDraw} onClick={() => void draw()}>
          {busy ? "뽑는 중…" : pending ? "뽑기 결과 다시 확인" : `뽑기 · ${NICKNAME_TAG_RULES.price.toLocaleString("ko-KR")}G`}
        </button>
      </div>
      <p className="subtle-note">오늘 {drawsToday}/{NICKNAME_TAG_RULES.dailyLimit}회 · 모은 태그 {tags?.tags.length ?? 0}개</p>
      {!shop.canPurchase && !shop.loading && <p className="subtle-note">운영자 계정은 별명 태그를 뽑지 않아요.</p>}
      {(error || shop.error) && <p className="form-message error" role="alert">{error || shop.error}</p>}
      <button type="button" className="text-button" onClick={() => go("/profile")}>내 별명 태그 보러 가기</button>
    </div>
    {result && <DrawResult tag={result} name={name} drawsToday={drawsToday} busy={equipping} onEquip={() => void equip(result)} onClose={() => setResult(null)} />}
  </div>;
}
