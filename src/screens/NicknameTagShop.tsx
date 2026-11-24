import { useEffect, useMemo, useRef, useState } from "react";
import { DAILY_FREE, NICKNAME_TAG_RULES, TAG_EVOLUTION_RULES } from "../../shared/balance";
import { TAG_GRADES, evolutionChance, gradeLabel, nextTagGrade, type NicknameTagGrade } from "../../shared/nickname-tags";
import type { NicknameTag, TagDrawInput, TagEvolution, TagEvolveInput } from "../../shared/types";
import { ApiFailure, refusedByServer } from "../api";
import { NickTag, Segmented, Toolbar, honorific, useNameParts } from "../components/UI";
import { BuyBar, ResultDialog } from "../components/BuyBar";
import { confetti, flipY, openSheet, reduced, toast, useCountUp } from "../motion";
import { ticketCount, useShop } from "../shop";
import { loopSfx, playSfx, preloadSfx } from "../sfx";
import { usePurchaseConfirm } from "../components/PurchaseConfirm";

const gradeClass = (grade: NicknameTagGrade) => `grade-${grade.toLowerCase()}`;
const gradeName = (grade: NicknameTagGrade) => `${grade}등급`;
/** Tags that can pay for evolving `tag`: the same phrase, not worn, not itself. */
const materialsFor = (tag: NicknameTag, tags: readonly NicknameTag[]) =>
  nextTagGrade(tag.grade) ? tags.filter(other => other.id !== tag.id && other.text === tag.text && !other.equipped) : [];

/** The drawn tag, with a shortcut to wear it right away. */
function DrawResult({ tag, name, drawsToday, busy, duplicate, onEquip, onDiscard, onClose }: {
  tag: NicknameTag; name: string; drawsToday: number; busy: boolean; duplicate: boolean; onEquip: () => void; onDiscard: () => Promise<boolean>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = openSheet(dialog.current!);
    flipY(chip.current, { delay: 300 });
    // TAG-01: the card flips over, then its grade answers (S big, A a little smaller, B·C a coin).
    playSfx("tag-flip", { delay: .3 });
    if (tag.grade === "S") playSfx("jackpot", { delay: .8 });
    else if (tag.grade === "A") playSfx("jackpot", { delay: .8, gain: .7 });
    else playSfx("coin", { delay: .8 });
    if (!reduced() && (tag.grade === "S" || tag.grade === "A")) confetti(chip.current, { spread: 140 });
    return close;
  }, [tag.grade]);
  return <dialog className="color-picker-dialog tag-draw-dialog" ref={dialog} aria-labelledby="tag-draw-title"
    onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <div className={`tag-draw-sheet ${gradeClass(tag.grade)}`}>
      <span className="sheet-handle" aria-hidden="true" />
      <h2 id="tag-draw-title" className="sr-only">새 별명 태그를 뽑았어요</h2>
      <small className="tag-draw-grade">{gradeLabel(tag.grade)}</small>
      <div className="tag-draw-card" ref={chip}><NickTag tag={tag} /><strong>{name}</strong></div>
      <p className="tag-draw-meta">{tag.payment === "free" || tag.payment === "ticket" ? "뽑기권 1장" : `-${NICKNAME_TAG_RULES.price.toLocaleString("ko-KR")}G`} · 오늘 {drawsToday}/{NICKNAME_TAG_RULES.dailyLimit}회</p>
      {tag.equipped ? <p className="tag-note">지금 달고 있어요.</p>
        : duplicate ? <p className="tag-note tag-note-evolve">같은 별명이 인벤토리에 있어요! 보관하면 진화에 도전할 수 있어요.</p>
        : <p className="tag-note">마음에 안 들면 버릴 수 있어요. 버린 태그는 인벤토리에 들어가지 않아요.</p>}
      <div className="tag-draw-actions">
        {tag.equipped
          ? <button type="button" className="secondary-button cancel-button" onClick={() => dialog.current?.close()}>닫기</button>
          : <button type="button" className="secondary-button cancel-button" disabled={busy} onClick={() => void onDiscard().then(done => { if (done) dialog.current?.close(); })}>버리기</button>}
        {!tag.equipped && <button type="button" className="secondary-button" disabled={busy} onClick={() => dialog.current?.close()}>보관하기</button>}
        {!tag.equipped && <button type="button" className="primary-button" disabled={busy} onClick={onEquip}>{busy ? "처리 중…" : "지금 달기"}</button>}
      </div>
    </div>
  </dialog>;
}

/** One tag of the inventory: wear it, evolve it or throw it away. */
function TagSheet({ tag, name, materials, busy, onWear, onEvolve, onDiscard, onClose }: {
  tag: NicknameTag; name: string; materials: number; busy: boolean;
  onWear: (wear: boolean) => void; onEvolve: () => void; onDiscard: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => openSheet(dialog.current!), []);
  const top = !nextTagGrade(tag.grade);
  return <dialog className="color-picker-dialog tag-draw-dialog" ref={dialog} aria-labelledby="tag-sheet-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`tag-draw-sheet ${gradeClass(tag.grade)}`}>
      <span className="sheet-handle" aria-hidden="true" />
      <h2 id="tag-sheet-title" className="sr-only">{gradeLabel(tag.grade)} {tag.text}</h2>
      <small className="tag-draw-grade">{gradeLabel(tag.grade)}</small>
      <div className="tag-draw-card"><NickTag tag={tag} /><strong>{name}</strong></div>
      <p className="tag-note">{top ? "S등급은 가장 높은 등급이라 더 진화하지 않아요."
        : materials > 0 ? `같은 별명이 ${materials}개 더 있어요. 하나를 재료로 써서 ${gradeName(nextTagGrade(tag.grade)!)} 진화에 도전할 수 있어요.`
        : "같은 별명을 하나 더 뽑으면 진화에 도전할 수 있어요."}</p>
      <div className="tag-sheet-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={() => onWear(!tag.equipped)}>{tag.equipped ? "별명 떼기" : "이 별명 달기"}</button>
        <button type="button" className="secondary-button tag-evolve-button" disabled={busy || top || materials < 1} onClick={onEvolve}>진화 도전</button>
        <button type="button" className="secondary-button cancel-button" disabled={busy || tag.equipped} title={tag.equipped ? "달고 있는 태그는 먼저 떼어 주세요" : undefined} onClick={onDiscard}>버리기</button>
      </div>
    </div>
  </dialog>;
}

/** Pick the material and see the odds before an attempt. */
function EvolveSheet({ tag, materials, freeLeft, gold, onStart, onClose }: {
  tag: NicknameTag; materials: NicknameTag[]; freeLeft: number; gold: number; onStart: (material: NicknameTag) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => openSheet(dialog.current!), []);
  const [materialId, setMaterialId] = useState(materials[0]?.id ?? "");
  const material = materials.find(entry => entry.id === materialId) ?? materials[0];
  const target = nextTagGrade(tag.grade)!;
  const chance = material ? evolutionChance(tag.grade, material.grade, TAG_EVOLUTION_RULES) : null;
  const cost = freeLeft > 0 ? 0 : TAG_EVOLUTION_RULES.price;
  const short = gold < cost;
  return <dialog className="color-picker-dialog tag-draw-dialog" ref={dialog} aria-labelledby="tag-evolve-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="tag-draw-sheet tag-evolve-sheet">
      <span className="sheet-handle" aria-hidden="true" />
      <h2 id="tag-evolve-title">별명 태그 진화</h2>
      <div className="tag-evolve-path" aria-label={`${gradeName(tag.grade)}에서 ${gradeName(target)}으로`}>
        <span><NickTag tag={tag} /><small>{gradeName(tag.grade)}</small></span>
        <i aria-hidden="true">→</i>
        <span><NickTag tag={{ grade: target, text: tag.text }} /><small>{gradeName(target)}</small></span>
      </div>
      <fieldset className="tag-evolve-materials">
        <legend>재료로 쓸 태그</legend>
        {materials.map(entry => {
          const odds = evolutionChance(tag.grade, entry.grade, TAG_EVOLUTION_RULES)!;
          return <label key={entry.id} className={entry.id === material?.id ? "on" : ""}>
            <input type="radio" name="tag-evolve-material" checked={entry.id === material?.id} onChange={() => setMaterialId(entry.id)} />
            <NickTag tag={entry} /><small>{gradeName(entry.grade)}</small><b>{odds.bonus > 0 ? `보너스 +${odds.bonus}%` : "보너스 없음"}</b>
          </label>;
        })}
      </fieldset>
      {chance && <p className="tag-evolve-chance">성공 확률 <strong>{chance.total}%</strong>{chance.bonus > 0 && <small> (기본 {chance.base}% + 등급 차이 {chance.bonus}%)</small>}</p>}
      <p className="tag-note">성공하면 {gradeName(target)}으로 올라가고 재료 태그는 사라져요. 실패하면 {TAG_EVOLUTION_RULES.loseOnFailPercent}% 확률로 재료 태그가 사라져요.</p>
      <p className="tag-evolve-cost">{freeLeft > 0 ? `오늘 무료 도전 ${freeLeft}회 남음` : `무료 도전을 모두 썼어요 · 1회 ${TAG_EVOLUTION_RULES.price}G`}</p>
      {short && <p className="form-message error" role="alert">골드가 부족해요.</p>}
      <div className="tag-draw-actions">
        <button type="button" className="secondary-button cancel-button" onClick={onClose}>취소</button>
        <button type="button" className="primary-button" disabled={!material || short} onClick={() => material && onStart(material)}>
          {cost ? `진화 도전 · ${cost}G` : "진화 도전 · 무료"}
        </button>
      </div>
    </div>
  </dialog>;
}

/** While the attempt runs: the two tags swirl into the pot inside the spinning glow. It
 * cannot be dismissed; the result modal replaces it. */
function EvolvingOverlay({ tag }: { tag: NicknameTag }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => openSheet(dialog.current!), []);
  // TAG-02: the swirl hums until the result replaces this overlay.
  useEffect(() => { const hum = loopSfx("tag-evolving"); return () => hum.stop(); }, []);
  return <dialog ref={dialog} className="launch-dialog result-dialog tag-evolving" aria-label="별명 태그 진화 중" onCancel={event => event.preventDefault()}>
    <div className="tag-evolving-stage" aria-hidden="true">
      <span className="tag-evolving-ring" /><span className="tag-evolving-ring second" />
      {Array.from({ length: 6 }, (_, index) => <b key={index} style={{ "--i": index } as React.CSSProperties} />)}
      <img className="tag-evolving-art" src="/tags/evolve-working.webp" alt="" width="150" height="150" />
    </div>
    <div className="tag-evolving-chip"><NickTag tag={tag} /></div>
    <h2 role="status">진화 중…</h2>
    <p>두근두근, 별명 태그에 힘을 모으고 있어요.</p>
  </dialog>;
}

function EvolutionResult({ result, onClose }: { result: TagEvolution; onClose: () => void }) {
  const chip = useRef<HTMLDivElement>(null);
  // TAG-03: success fanfare; a failure runs down, and a lost material then vanishes with a puff.
  useEffect(() => {
    if (result.success) { playSfx("jackpot"); return; }
    playSfx("fail");
    if (!result.materialLost) return;
    const timer = window.setTimeout(() => playSfx("tag-vanish"), 900);
    return () => window.clearTimeout(timer);
  }, [result.success, result.materialLost]);
  useEffect(() => {
    if (!result.success) return;
    flipY(chip.current, { delay: 150 });
    confetti(chip.current, { n: 36, spread: 150 });
  }, [result.success]);
  return <ResultDialog label="별명 태그 진화 결과" className={`tag-evolve-result ${result.success ? "won" : "lost"} ${gradeClass(result.tag.grade)}`} onClose={onClose}>
    <img className="tag-evolve-result-art" src={`/tags/evolve-${result.success ? "success" : result.materialLost ? "lost" : "fail"}.webp`} alt="" width="150" height="150" />
    <h2 role="status">{result.success ? "진화 성공!" : "진화 실패…"}</h2>
    <div className="tag-draw-card" ref={chip}><NickTag tag={result.tag} /></div>
    <p>{result.success
      ? <><strong>{gradeName(result.fromGrade)} → {gradeName(result.toGrade)}</strong><br />재료 태그는 힘을 다하고 사라졌어요.</>
      : result.materialLost ? <><strong>재료 태그가 사라졌어요</strong><br />「{result.text}」 {gradeName(result.materialGrade)} 태그를 잃었어요. 진화하려던 태그는 그대로예요.</>
      : <><strong>재료 태그는 무사해요</strong><br />두 태그 모두 그대로예요. 다시 도전해 볼 수 있어요.</>}</p>
    <small className="result-dialog-eyebrow">성공 확률 {result.chance}% · {result.cost ? `-${result.cost}G` : "무료 도전"}</small>
    <button type="button" className="primary-button" autoFocus onClick={onClose}>확인</button>
  </ResultDialog>;
}

export function NicknameTagShop({ username, displayName, onBack, inventory = false }: {
  username: string; displayName?: string; onBack: () => void;
  /** Open on the inventory (the route 내 정보 links to). */
  inventory?: boolean;
}) {
  const shop = useShop();
  // The bare nickname: the drawn tag stands in for the one worn now, so the preview must not show both.
  const name = honorific(useNameParts(username, displayName).name);
  const latest = useRef(shop);
  latest.current = shop;
  const shownGold = useCountUp(shop.gold);
  const [busy, setBusy] = useState(false);
  const [equipping, setEquipping] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NicknameTag | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [evolveId, setEvolveId] = useState<string | null>(null);
  const [evolving, setEvolving] = useState<NicknameTag | null>(null);
  const [evolution, setEvolution] = useState<TagEvolution | null>(null);
  /** An attempt whose answer never arrived: the same request asks again. */
  const [unresolved, setUnresolved] = useState<{ input: TagEvolveInput; tag: NicknameTag } | null>(null);
  const [confirmSheet, ask] = usePurchaseConfirm();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    void latest.current.refresh("tag").catch(() => {});
    preloadSfx(["tag-flip", "tag-evolving", "tag-vanish", "jackpot", "coin", "fail", "ui-deny"]);
  }, []);
  const tags = shop.tags;
  const list = tags?.tags ?? [];
  const pending = shop.pending?.kind === "tag" ? shop.pending.input as TagDrawInput : null;
  const drawsToday = tags?.drawsToday ?? 0;
  const left = NICKNAME_TAG_RULES.dailyLimit - drawsToday;
  const freeEvolves = Math.max(0, TAG_EVOLUTION_RULES.dailyFree - (tags?.evolvesToday ?? 0));
  /** One 뽑기권 count: today's free draws (used first) plus owned tickets, then
   * gold — the order the server decides on its own. */
  const tickets = ticketCount("tag", shop);
  const canDraw = Boolean(tags) && shop.canPurchase && !busy && !shop.loading && (!shop.pending || Boolean(pending))
    && (Boolean(pending) || (left > 0 && (tickets > 0 || shop.gold >= NICKNAME_TAG_RULES.price)));
  const groups = useMemo(() => TAG_GRADES.map(rule => ({ ...rule, tags: list.filter(tag => tag.grade === rule.grade) })), [list]);
  const opened = list.find(tag => tag.id === openId) ?? null;
  const evolveTarget = list.find(tag => tag.id === evolveId) ?? null;
  async function draw() {
    if (!canDraw) return;
    if (!pending && !(await ask({ title: "별명 태그를 뽑을까요?", cost: tickets > 0 ? "뽑기권 1장" : `골드 ${NICKNAME_TAG_RULES.price.toLocaleString("ko-KR")}G`,
      detail: `오늘 ${drawsToday + 1}/${NICKNAME_TAG_RULES.dailyLimit}번째 뽑기예요.`, confirmLabel: "뽑기" }))) return;
    setBusy(true);
    setError("");
    try {
      const next = await shop.drawTag(pending ?? { requestId: crypto.randomUUID() });
      if (next.draw) setResult(next.draw);
    } catch (cause) {
      if (cause instanceof ApiFailure && /INSUFFICIENT|NOT_ENOUGH/.test(cause.code ?? "")) playSfx("ui-deny");
      setError(cause instanceof Error ? cause.message : "별명 태그를 뽑지 못했어요. 같은 버튼으로 다시 확인해 주세요.");
    } finally { setBusy(false); }
  }
  async function discard(tag: NicknameTag): Promise<boolean> {
    setEquipping(true);
    setError("");
    try {
      await shop.discardTag(tag.id);
      toast("별명 태그를 버렸어요");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "별명 태그를 버리지 못했어요.");
      return false;
    } finally { setEquipping(false); }
  }
  async function wear(tagId: string | null): Promise<boolean> {
    setEquipping(true);
    setError("");
    try {
      await shop.equipTag(tagId);
      toast(tagId ? "별명 태그를 달았어요" : "별명 태그를 뗐어요");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "별명 태그를 바꾸지 못했어요.");
      return false;
    } finally { setEquipping(false); }
  }
  async function evolve(input: TagEvolveInput, tag: NicknameTag) {
    setEvolveId(null);
    setOpenId(null);
    setError("");
    setEvolving(tag);
    // The animation always plays out, however fast the answer comes back.
    const wait = new Promise(resolve => window.setTimeout(resolve, reduced() ? 600 : 2600));
    try {
      const [next] = await Promise.all([shop.evolveTag(input), wait]);
      if (!mounted.current) return;
      setUnresolved(null);
      setEvolving(null);
      if (next.evolution) setEvolution(next.evolution);
    } catch (cause) {
      await wait;
      if (!mounted.current) return;
      setEvolving(null);
      // A refusal spent nothing; anything else may have gone through, so the same request can ask again.
      const rejected = refusedByServer(cause);
      if (cause instanceof ApiFailure && /INSUFFICIENT|NOT_ENOUGH/.test(cause.code ?? "")) playSfx("ui-deny");
      setUnresolved(rejected ? null : { input, tag });
      setError(cause instanceof Error ? cause.message : "진화 결과를 확인하지 못했어요.");
      if (rejected) void latest.current.refresh("tag").catch(() => {});
    }
  }
  const [view, setView] = useState<"draw" | "inventory">(inventory ? "inventory" : "draw");
  const message = error || shop.error;
  return <div className={`tag-shop ${view === "draw" ? "with-buy-bar" : ""}`}>
    <Toolbar title="별명 태그 뽑기" onBack={onBack} gold={shownGold} />
    <div className="screen-body stack">
      <Segmented label="별명 태그 화면" options={[{ value: "draw", label: "뽑기" }, { value: "inventory", label: `인벤토리 ${list.length}` }]} value={view}
        onChange={next => { setView(next); setError(""); }} />
      {view === "draw" ? <>
        <section className="card tag-shop-hero">
          <div className="tag-shop-sample" aria-hidden="true">
            <NickTag tag={{ grade: "S", text: "전설적인" }} /><NickTag tag={{ grade: "A", text: "반짝이는" }} />
            <NickTag tag={{ grade: "B", text: "느긋한" }} /><NickTag tag={{ grade: "C", text: "배가 고픈" }} />
          </div>
          <p>뽑은 태그는 인벤토리에 모여요. 인벤토리에서 골라 달면 앱 어디서든 내 닉네임 앞에 보여요.<br />같은 별명을 또 뽑으면 한 등급 위로 진화에 도전할 수 있어요.</p>
          <div className="tag-shop-odds" aria-label="등급별 확률">
            {TAG_GRADES.map(grade => <div key={grade.grade} className={gradeClass(grade.grade)}><strong>{grade.label}</strong><span>{grade.look}</span><small>{grade.chance}%</small></div>)}
          </div>
        </section>
        <p className="subtle-note">뽑기권 {tickets}장 · 오늘 {drawsToday}/{NICKNAME_TAG_RULES.dailyLimit}회 · 모은 태그 {list.length}개</p>
        {shop.canPurchase && <p className="subtle-note">뽑기권은 매일 자정 {DAILY_FREE.tag}장씩 새로 받아요. 그날 받은 뽑기권부터 써요.</p>}
      </> : <>
        <section className="card tag-inventory-now" aria-label="지금 내 별명">
          <div className="tag-collection-head"><h2>지금 내 별명</h2>{tags?.equipped && <small>{gradeLabel(tags.equipped.grade)}</small>}</div>
          <div className="tag-inventory-preview">{tags?.equipped ? <NickTag tag={tags.equipped} /> : <span className="tag-inventory-none">별명 없음</span>}<strong>{name}</strong></div>
          <button type="button" className="secondary-button cancel-button tag-untag" disabled={equipping || !tags?.equipped} onClick={() => void wear(null)}>별명 떼기</button>
        </section>
        <section className="card tag-evolve-info" aria-label="별명 태그 진화">
          <div className="tag-collection-head"><h2>진화</h2><small>오늘 무료 {freeEvolves}/{TAG_EVOLUTION_RULES.dailyFree}회 남음</small></div>
          <p className="tag-note">같은 별명 두 개가 있으면 하나를 재료로 써서 한 등급 위로 진화에 도전해요. 무료 도전을 다 쓰면 1회 {TAG_EVOLUTION_RULES.price}G예요.</p>
          <details className="tag-evolve-rules"><summary>진화 확률 보기</summary>
            <table><thead><tr><th>진화</th><th>성공 확률</th></tr></thead><tbody>
              <tr><td>C등급 → B등급</td><td>{TAG_EVOLUTION_RULES.chance.B}%</td></tr>
              <tr><td>B등급 → A등급</td><td>{TAG_EVOLUTION_RULES.chance.A}%</td></tr>
              <tr><td>A등급 → S등급</td><td>{TAG_EVOLUTION_RULES.chance.S}%</td></tr>
            </tbody></table>
            <p className="tag-note">두 태그의 등급이 1단계 다르면 +{TAG_EVOLUTION_RULES.bonusPerStep}%, 2단계 이상 다르면 +{TAG_EVOLUTION_RULES.bonusPerStep * TAG_EVOLUTION_RULES.maxBonusSteps}% 보너스가 붙어요. 성공하면 재료 태그는 사라지고, 실패하면 {TAG_EVOLUTION_RULES.loseOnFailPercent}% 확률로 사라져요. S등급은 더 진화하지 않아요.</p>
          </details>
        </section>
        {!tags ? <p className="subtle-note" role="status">인벤토리를 불러오는 중…</p> : list.length === 0
          ? <section className="card empty-state"><h2>아직 모은 별명 태그가 없어요</h2><p>뽑기에서 첫 별명 태그를 뽑아 보세요.</p></section>
          : groups.map(group => <section key={group.grade} className={`card tag-grade-group ${gradeClass(group.grade)}`} aria-label={`${group.label} 별명 태그`}>
            <div className="tag-collection-head"><h2>{group.label} <span>{group.look}</span></h2><small>{group.tags.length}개</small></div>
            {group.tags.length ? <ul className="tag-collection">
              {group.tags.map(tag => {
                const evolvable = materialsFor(tag, list).length > 0;
                return <li key={tag.id}>
                  <button type="button" aria-pressed={tag.equipped} disabled={equipping} data-tag-id={tag.id}
                    aria-label={`${gradeLabel(tag.grade)} ${tag.text}${tag.equipped ? " · 달고 있음" : ""}${evolvable ? " · 진화 가능" : ""}`} onClick={() => setOpenId(tag.id)}>
                    <NickTag tag={tag} />
                    {tag.equipped && <small aria-hidden="true">단 태그</small>}
                    {evolvable && <small className="tag-evolvable" aria-hidden="true">진화 가능</small>}
                  </button>
                </li>;
              })}
            </ul> : <p className="tag-note">아직 없어요.</p>}
          </section>)}
      </>}
      {!shop.canPurchase && !shop.loading && <p className="subtle-note">운영자 계정은 별명 태그를 뽑지 않아요.</p>}
      {message && <p className="form-message error" role="alert">{message}</p>}
      {unresolved && !evolving && <button type="button" className="text-button" onClick={() => void evolve(unresolved.input, unresolved.tag)}>진화 결과 다시 확인</button>}
    </div>
    {view === "draw" && <BuyBar label="별명 태그 뽑기">
      {shop.canPurchase && !pending && left <= 0 && <p className="subtle-note">오늘은 모두 뽑았어요. 내일 다시 뽑을 수 있어요.</p>}
      {shop.canPurchase && !pending && left > 0 && tickets <= 0 && shop.gold < NICKNAME_TAG_RULES.price && <p className="subtle-note">뽑기권과 골드가 부족해요.</p>}
      <button type="button" className="primary-button" disabled={!canDraw} onClick={() => void draw()}>
        {busy ? "뽑는 중…" : pending ? "뽑기 결과 다시 확인" : tickets > 0 ? `뽑기 · 뽑기권 1장 (보유 ${tickets}장)` : `뽑기 · ${NICKNAME_TAG_RULES.price.toLocaleString("ko-KR")}G`}
      </button>
    </BuyBar>}
    {result && <DrawResult tag={result} name={name} drawsToday={drawsToday} busy={equipping}
      duplicate={list.some(tag => tag.id !== result.id && tag.text === result.text)}
      onEquip={() => void wear(result.id).then(done => { if (done) setResult({ ...result, equipped: true }); })} onDiscard={() => discard(result)} onClose={() => setResult(null)} />}
    {opened && !evolveTarget && <TagSheet tag={opened} name={name} materials={materialsFor(opened, list).length} busy={equipping}
      onWear={wearIt => void wear(wearIt ? opened.id : null).then(done => { if (done) setOpenId(null); })}
      onEvolve={() => setEvolveId(opened.id)}
      onDiscard={() => void discard(opened).then(done => { if (done) setOpenId(null); })} onClose={() => setOpenId(null)} />}
    {evolveTarget && <EvolveSheet tag={evolveTarget} materials={materialsFor(evolveTarget, list)} freeLeft={freeEvolves} gold={shop.gold}
      onStart={material => void evolve({ requestId: crypto.randomUUID(), tagId: evolveTarget.id, materialId: material.id }, evolveTarget)} onClose={() => setEvolveId(null)} />}
    {evolving && <EvolvingOverlay tag={evolving} />}
    {evolution && !evolving && <EvolutionResult result={evolution} onClose={() => setEvolution(null)} />}
    {confirmSheet}
  </div>;
}
