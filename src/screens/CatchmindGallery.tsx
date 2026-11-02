import { useCallback, useEffect, useRef, useState } from "react";
import type { CatchmindGalleryResponse, CatchmindGalleryRound, CatchmindPlayer } from "../../shared/types";
import { useCatchmind } from "../catchmind";
import { Avatar, Chevron, Toolbar, useDisplayNameLookup } from "../components/UI";
import "../preview.css";

const emptyMessage = "아직 완성된 그림이 없어요. 첫 그림의 주인공이 되어 보세요!";
const endedTime = (value: string) => new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(value));

function Person({ player, demo }: { player: CatchmindPlayer; demo: boolean }) {
  const displayNameOf = useDisplayNameLookup();
  return <span className="cm-history-person"><Avatar username={player.username} userId={player.id} photoVersion={player.photoVersion}
    artKey={demo ? undefined : player.character} size={28} /><span>{displayNameOf(player.username, player.displayName)}</span></span>;
}
function Details({ round, demo }: { round: CatchmindGalleryRound; demo: boolean }) {
  return <dl className="cm-history-details">
    <div><dt>정답</dt><dd><strong>{round.answer}</strong></dd></div>
    <div><dt>그린 사람</dt><dd><Person player={round.drawer} demo={demo} /></dd></div>
    <div><dt>맞힌 사람</dt><dd>{round.winner ? <Person player={round.winner} demo={demo} /> : "아무도 못 맞혔어요"}</dd></div>
    <div><dt>끝난 시각</dt><dd><time dateTime={round.endedAt}>{endedTime(round.endedAt)}</time></dd></div>
  </dl>;
}

function useGallery(before?: number) {
  const { gallery } = useCatchmind();
  const [page, setPage] = useState<CatchmindGalleryResponse>({ rounds: [], nextBefore: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const load = useCallback(async (cursor?: number) => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true); setError("");
    try {
      const result = await gallery(cursor);
      if (!mounted.current) return;
      setPage(previous => ({ rounds: [...previous.rounds, ...result.rounds.filter(round => !previous.rounds.some(item => item.id === round.id))], nextBefore: result.nextBefore }));
      return result;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "그림을 불러오지 못했어요.");
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [gallery]);
  useEffect(() => {
    mounted.current = true;
    void load(before);
    return () => { mounted.current = false; };
  }, [load, before]);
  return { ...page, loading, error, load, retry: () => load(page.nextBefore ?? before) };
}
type Gallery = ReturnType<typeof useGallery>;

/** Both entry points share a native modal, focus trapping and keyboard controls. */
function GalleryModal({ selected, rounds, gallery, demo, onSelect, onClose }: {
  selected: CatchmindGalleryRound; rounds: CatchmindGalleryRound[]; gallery: Gallery; demo: boolean;
  onSelect: (round: CatchmindGalleryRound) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const navigating = useRef(false);
  const index = rounds.findIndex(round => round.id === selected.id);
  const older = rounds[index + 1];
  const newer = index > 0 ? rounds[index - 1] : undefined;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  async function previous() {
    if (navigating.current || gallery.loading) return;
    if (older) { onSelect(older); return; }
    if (gallery.nextBefore === null) return;
    navigating.current = true;
    try {
      const page = await gallery.load(gallery.nextBefore);
      if (page?.rounds[0]) onSelect(page.rounds[0]);
    } finally { navigating.current = false; }
  }
  // Reaching either end can disable the focused navigation button. Keep arrow
  // navigation working even when the browser then moves focus to the body.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!dialog.current?.open || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); void previous(); }
      if (event.key === "ArrowRight") { event.preventDefault(); if (newer && !gallery.loading) onSelect(newer); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });
  return <dialog ref={dialog} className="cm-gallery-modal" aria-labelledby="cm-gallery-title" onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="cm-gallery-modal-head"><h2 id="cm-gallery-title">제 {selected.number}판</h2><button className="text-button" onClick={() => dialog.current?.close()} autoFocus>닫기</button></div>
    <img className="cm-gallery-picture" src={selected.image} width={512} height={512} alt={`제 ${selected.number}판 그림`} />
    <Details round={selected} demo={demo} />
    {gallery.error && <p className="form-message error" role="alert">{gallery.error}<button className="text-button" onClick={() => void gallery.retry()}>다시 불러오기</button></p>}
    <nav className="cm-gallery-navigation" aria-label="그림 넘기기">
      <button className="secondary-button" disabled={!older && gallery.nextBefore === null} aria-disabled={gallery.loading || (!older && gallery.nextBefore === null)} onClick={() => void previous()}><Chevron size={18} />이전 판</button>
      <span role="status">{gallery.loading ? "불러오는 중…" : `${selected.number}판`}</span>
      <button className="secondary-button" disabled={!newer} aria-disabled={gallery.loading || !newer} onClick={() => { if (newer && !gallery.loading) onSelect(newer); }}>다음 판<Chevron direction="right" size={18} /></button>
    </nav>
  </dialog>;
}

function PreviousRoundModal({ initial, demo, onClose }: { initial: CatchmindGalleryRound; demo: boolean; onClose: () => void }) {
  const gallery = useGallery();
  const [selected, setSelected] = useState(initial);
  const rounds = gallery.rounds.some(round => round.id === initial.id) ? gallery.rounds
    : [...gallery.rounds, initial].sort((a, b) => b.number - a.number);
  return <GalleryModal selected={selected} rounds={rounds} gallery={gallery} demo={demo} onSelect={setSelected} onClose={onClose} />;
}

export function PreviousCatchmindRound({ round, demo, galleryHref, loading }: {
  round: CatchmindGalleryRound | null; demo: boolean; galleryHref: string; loading: boolean;
}) {
  const [selected, setSelected] = useState<CatchmindGalleryRound | null>(null);
  return <section className="pg-card cm-previous-round" aria-label="지난 판">
    <div className="cm-history-head"><h2>지난 판</h2><a className="text-button" href={galleryHref}>갤러리 보기</a></div>
    {round ? <>
      <button className="cm-previous-open" aria-label={`지난 판 제 ${round.number}판 크게 보기`} onClick={() => setSelected(round)}>
        <img src={round.image} width={100} height={100} loading="lazy" alt={`제 ${round.number}판 그림`} />
        <span><strong>제 {round.number}판</strong><span>{round.answer}</span><small>그림 크게 보기 <Chevron direction="right" size={14} /></small></span>
      </button>
      <Details round={round} demo={demo} />
    </> : <p className="cm-gallery-empty" role="status">{loading ? "지난 판을 불러오는 중…" : emptyMessage}</p>}
    {selected && <PreviousRoundModal initial={selected} demo={demo} onClose={() => setSelected(null)} />}
  </section>;
}

export function CatchmindGallery({ demo, gold, onBack }: { demo: boolean; gold: number; onBack: () => void }) {
  const gallery = useGallery();
  const [selected, setSelected] = useState<CatchmindGalleryRound | null>(null);
  return <section className="preview-game cm-gallery">
    <Toolbar title="캐치마인드 갤러리" onBack={onBack} gold={gold} />
    <div className="pg-stack">
      <p className="cm-gallery-intro">함께 그린 그림과 정답을 모았어요.</p>
      <div className="cm-gallery-grid" aria-label="완성된 그림">
        {gallery.rounds.map(round => <button key={round.id} className="cm-gallery-tile" onClick={() => setSelected(round)} aria-label={`${round.number}판 · ${round.winner ? "맞힌 판" : "못 맞힌 판"} 크게 보기`}>
          <img src={round.image} alt={`제 ${round.number}판 그림`} width={160} height={160} loading="lazy" />
          <span className="cm-gallery-number">{round.number}판</span>
          <span className={`cm-gallery-outcome ${round.winner ? "correct" : "missed"}`} aria-hidden="true">{round.winner ? "✓ 맞힘" : "− 못 맞힘"}</span>
        </button>)}
      </div>
      {gallery.error && <div className="cm-error"><p className="form-message error" role="alert">{gallery.error}</p><button className="text-button" onClick={() => void gallery.retry()}>다시 불러오기</button></div>}
      {gallery.loading && <p className="subtle-note" role="status">그림을 불러오는 중…</p>}
      {!gallery.loading && !gallery.error && !gallery.rounds.length && <p className="cm-gallery-empty" role="status">{emptyMessage}</p>}
      {gallery.nextBefore !== null && <button className="secondary-button" disabled={gallery.loading} onClick={() => void gallery.load(gallery.nextBefore!)}>더 보기</button>}
    </div>
    {selected && <GalleryModal selected={selected} rounds={gallery.rounds} gallery={gallery} demo={demo} onSelect={setSelected} onClose={() => setSelected(null)} />}
  </section>;
}
