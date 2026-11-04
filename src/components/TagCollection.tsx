import { useEffect, useRef, useState } from "react";
import { gradeLabel } from "../../shared/nickname-tags";
import { NickTag } from "./UI";
import { toast } from "../motion";
import { useShop } from "../shop";

/** 내 정보 — my collected nickname tags. Pressing one wears it; one can be worn at a time. */
export function TagCollection({ shopHref }: { shopHref: string }) {
  const shop = useShop();
  const latest = useRef(shop);
  latest.current = shop;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void latest.current.refresh("tag").catch(() => {}); }, []);
  if (!shop.canPurchase) return null;
  const state = shop.tags;
  async function wear(tagId: string | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await shop.equipTag(tagId);
      toast(tagId ? "별명 태그를 달았어요" : "별명 태그를 뗐어요");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "별명 태그를 바꾸지 못했어요.");
    } finally { setBusy(false); }
  }
  return <section className="card tag-collection-card" aria-label="내 별명 태그" aria-busy={busy}>
    <h2>내 별명 태그</h2>
    {!state ? <p className="tag-note">불러오는 중…</p> : state.tags.length === 0 ? <>
      <p className="tag-note">아직 모은 별명 태그가 없어요. 상점의 <b>별명 태그 뽑기</b>로 뽑아 보세요.</p>
      <a className="secondary-button tag-shop-link" href={shopHref}>상점 가기</a>
    </> : <>
      <p className="tag-note">{state.equipped ? "지금 단 별명이에요. 다른 태그를 누르면 바꿔 달아요." : "태그를 누르면 닉네임 앞에 달아요."}</p>
      <ul className="tag-collection">
        {state.tags.map(tag => <li key={tag.id}>
          <button type="button" aria-pressed={tag.equipped} disabled={busy}
            aria-label={`${gradeLabel(tag.grade)} ${tag.text}${tag.equipped ? " · 달고 있음" : ""}`}
            onClick={() => { if (!tag.equipped) void wear(tag.id); }}>
            <NickTag tag={tag} />{tag.equipped && <small>달고 있음</small>}
          </button>
        </li>)}
      </ul>
      {state.equipped && <button type="button" className="secondary-button" disabled={busy} onClick={() => void wear(null)}>별명 떼기</button>}
      <p className="tag-note">모은 태그 {state.tags.length}개 · 단 태그는 앱 어디서든 내 닉네임 앞에 보여요.</p>
    </>}
    {error && <p className="form-message error" role="alert">{error}</p>}
  </section>;
}
