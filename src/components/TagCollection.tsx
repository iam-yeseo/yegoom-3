import { useEffect, useRef } from "react";
import { gradeLabel } from "../../shared/nickname-tags";
import { NickTag } from "./UI";
import { useShop } from "../shop";

/** 내 정보 — the tag I wear now. Choosing, evolving and discarding tags all live
 * in the tag shop's inventory, which this card links to. */
export function TagCollection({ shopHref }: { shopHref: string }) {
  const shop = useShop();
  const latest = useRef(shop);
  latest.current = shop;
  useEffect(() => { void latest.current.refresh("tag").catch(() => {}); }, []);
  if (!shop.canPurchase) return null;
  const state = shop.tags;
  return <section className="card tag-collection-card" aria-label="내 별명 태그">
    <div className="tag-collection-head">
      <h2>내 별명 태그</h2>
      {state && <small>모은 태그 {state.tags.length}개</small>}
    </div>
    {!state ? <p className="tag-note">불러오는 중…</p> : state.equipped
      ? <p className="tag-note tag-collection-current"><NickTag tag={state.equipped} /> <span>{gradeLabel(state.equipped.grade)} 태그를 달고 있어요.</span></p>
      : <p className="tag-note">{state.tags.length ? "지금은 별명 태그를 달고 있지 않아요." : "아직 모은 별명 태그가 없어요. 상점의 별명 태그 뽑기로 뽑아 보세요."}</p>}
    <p className="tag-note">별명을 달거나 떼고, 진화시키는 건 별명 태그 인벤토리에서 해요.</p>
    <div className="tag-collection-actions"><a className="secondary-button tag-shop-link" href={shopHref}>별명 태그 인벤토리 열기</a></div>
  </section>;
}
