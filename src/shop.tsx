import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Inventory, KujiPurchaseInput, KujiResponse, KujiState, LedgerEntry, LottoNotice, LottoPurchaseInput, LottoResponse, LottoState, ShopKind, ShopState, SpeettoPurchaseInput, SpeettoResponse, SpeettoState, SlotResponse, SlotSpinInput, SlotState, NicknameTagState, NicknameTagView, TagDrawInput, TagResponse } from "../shared/types";
import { LOTTO_RULES } from "../shared/balance";
import { noticeDate } from "./lotto-notice";
import { api, ApiFailure } from "./api";
import { createShopPreview } from "./shop-preview";

export type PendingPurchase =
  | { kind: "kuji"; input: KujiPurchaseInput }
  | { kind: "lotto"; input: LottoPurchaseInput }
  | { kind: "speetto"; input: SpeettoPurchaseInput }
  | { kind: "slot"; input: SlotSpinInput }
  | { kind: "tag"; input: TagDrawInput };
type ShopResponse = ShopState | KujiResponse | LottoResponse | SpeettoResponse | SlotResponse | TagResponse;
interface ShopContextValue extends ShopState {
  kuji: KujiState | null;
  lotto: LottoState | null;
  speetto: SpeettoState | null;
  slot: SlotState | null;
  tags: NicknameTagState | null;
  loading: boolean;
  error: string;
  pending: PendingPurchase | null;
  refresh: (kind?: ShopKind) => Promise<void>;
  buyKuji: (input: KujiPurchaseInput) => Promise<KujiResponse>;
  buyLotto: (input: LottoPurchaseInput) => Promise<LottoResponse>;
  buySpeetto: (input: SpeettoPurchaseInput) => Promise<SpeettoResponse>;
  spinSlot: (input: SlotSpinInput) => Promise<SlotResponse>;
  drawTag: (input: TagDrawInput) => Promise<TagResponse>;
  /** Not a purchase: wearing or removing a tag never changes a balance. */
  equipTag: (tagId: string | null) => Promise<TagResponse>;
  claimPreviewLaunchGift: () => { inventory: Inventory; awarded: boolean };
}
const ShopContext = createContext<ShopContextValue | null>(null);
export function useShop(): ShopContextValue {
  const value = useContext(ShopContext);
  if (!value) throw new Error("ShopProvider is missing");
  return value;
}
function savedPending(key: string): PendingPurchase | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as PendingPurchase | null;
    if (!value || typeof value.input?.requestId !== "string") return null;
    if (value.kind === "kuji") return Number.isSafeInteger(value.input.boardId) && Array.isArray(value.input.positions) ? value : null;
    if (value.kind === "lotto") return Array.isArray(value.input.numbers) && ["gold", "ticket"].includes(value.input.payment) ? value : null;
    if (value.kind === "speetto") return ["gold", "ticket"].includes(value.input.payment) ? value : null;
    if (value.kind === "slot" || value.kind === "tag") return value;
    return null;
  } catch { return null; }
}

/** The same screens consume server state or an isolated, serverless preview. */
export function ShopProvider({ children, preview, accountKey, initial, previewGoldBonus, previewGameGold, previewAttendanceDate, transact, onPreviewChange, onServerRead }: {
  children: ReactNode;
  preview: boolean;
  accountKey: string;
  initial: ShopState;
  previewGoldBonus: number;
  previewGameGold: number;
  previewAttendanceDate: string;
  transact: <T>(action: () => Promise<T>) => Promise<T>;
  onPreviewChange: (state: ShopResponse, ledger: LedgerEntry[], score: number, lottoNotice: LottoNotice | null, tag: NicknameTagView | null) => void;
  onServerRead: (state: ShopResponse) => void;
}) {
  const storageKey = `yegoom3:shop:pending:${accountKey}`;
  const previewEngine = useRef<ReturnType<typeof createShopPreview> | null>(null);
  if (preview && !previewEngine.current) previewEngine.current = createShopPreview(initial.gold, previewGoldBonus, previewAttendanceDate);
  const latestPreviewBonus = useRef({ amount: previewGoldBonus, date: previewAttendanceDate, gameGold: previewGameGold });
  latestPreviewBonus.current = { amount: previewGoldBonus, date: previewAttendanceDate, gameGold: previewGameGold };
  const syncPreview = useCallback(() => {
    previewEngine.current?.setAttendanceBonus(latestPreviewBonus.current.amount, latestPreviewBonus.current.date);
    previewEngine.current?.setGameGoldBonus(latestPreviewBonus.current.gameGold);
    return previewEngine.current;
  }, []);
  const [state, setState] = useState<ShopState>(() => previewEngine.current?.read() ?? initial);
  const [kuji, setKuji] = useState<KujiState | null>(null);
  const [lotto, setLotto] = useState<LottoState | null>(null);
  const [speetto, setSpeetto] = useState<SpeettoState | null>(null);
  const [slot, setSlot] = useState<SlotState | null>(null);
  const [tags, setTags] = useState<NicknameTagState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingPurchase | null>(() => preview ? null : savedPending(storageKey));
  const pendingRef = useRef(pending);
  const writeInFlight = useRef(false);
  const deferredRead = useRef<ShopKind | "shop" | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const callbacks = useRef({ transact, onPreviewChange, onServerRead });
  callbacks.current = { transact, onPreviewChange, onServerRead };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (!preview && !writeInFlight.current) setState(initial);
  }, [preview, initial.gold, initial.inventory.lottoTickets, initial.inventory.speettoTickets, initial.inventory.tagTickets, initial.canPurchase, initial.serverTime]);
  const remember = useCallback((value: PendingPurchase | null) => {
    pendingRef.current = value;
    if (mounted.current) setPending(value);
    if (preview) return;
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch { /* In-memory retry still works when browser storage is unavailable. */ }
  }, [preview, storageKey]);
  const apply = useCallback((next: ShopResponse) => {
    if (!mounted.current) return;
    setState({ gold: next.gold, inventory: next.inventory, canPurchase: next.canPurchase, serverTime: next.serverTime });
    if ("kuji" in next) setKuji(next.kuji);
    if ("lotto" in next) setLotto(next.lotto);
    if ("speetto" in next) setSpeetto(next.speetto);
    if ("slot" in next) setSlot(next.slot);
    if ("tags" in next) setTags(next.tags);
    if (previewEngine.current) callbacks.current.onPreviewChange(next, previewEngine.current.ledger, previewEngine.current.score, previewEngine.current.lottoNotice(new Date(next.serverTime)), previewEngine.current.equippedTag);
  }, []);
  useEffect(() => {
    const engine = syncPreview();
    if (engine) apply(engine.read());
  }, [previewGoldBonus, previewGameGold, previewAttendanceDate, syncPreview, apply]);
  useEffect(() => {
    if (!preview) return;
    const now = Date.now();
    const todayDraw = Date.parse(`${noticeDate(now)}T${LOTTO_RULES.drawTime}+09:00`);
    const nextDraw = todayDraw > now ? todayDraw : todayDraw + 86_400_000;
    const timer = window.setTimeout(() => {
      const engine = syncPreview();
      if (engine) apply(engine.read());
    }, nextDraw - now);
    return () => clearTimeout(timer);
  }, [preview, state.serverTime, syncPreview, apply]);
  const refresh = useCallback(async (kind?: ShopKind) => {
    if (writeInFlight.current) { deferredRead.current = kind ?? "shop"; return; }
    const current = ++generation.current;
    setLoading(true);
    try {
      const engine = syncPreview();
      const next = engine ? engine.read(kind)
        : await (kind ? api[kind]() : api.shop());
      if (!mounted.current || current !== generation.current) return;
      apply(next);
      setError("");
      if (!previewEngine.current) callbacks.current.onServerRead(next);
    } catch (e) {
      if (mounted.current && current === generation.current) setError(e instanceof Error ? e.message : "상점을 불러오지 못했어요.");
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, [apply, syncPreview]);
  const purchase = useCallback(async <T extends ShopResponse>(attempt: PendingPurchase, action: () => Promise<T>): Promise<T> => {
    if (writeInFlight.current) throw new Error("구매를 확인하고 있어요. 잠시 기다려 주세요.");
    const previous = pendingRef.current;
    if (previous && JSON.stringify(previous) !== JSON.stringify(attempt)) {
      throw new Error("진행 중인 구매 화면에서 구매 결과를 먼저 확인해 주세요.");
    }
    generation.current++;
    writeInFlight.current = true;
    remember(attempt);
    setLoading(true);
    setError("");
    try {
      const next = await callbacks.current.transact(action);
      apply(next);
      remember(null);
      return next;
    } catch (e) {
      // A lost response may follow a committed purchase. Keep the same request
      // and payload across routes/reloads until its persisted receipt is read.
      if (preview || (e instanceof ApiFailure && e.status >= 400 && e.status < 500)) remember(null);
      if (mounted.current) setError(e instanceof Error ? e.message : "구매 결과를 확인하지 못했어요. 다시 확인해 주세요.");
      throw e;
    } finally {
      writeInFlight.current = false;
      if (mounted.current) setLoading(false);
      const nextRead = deferredRead.current;
      deferredRead.current = null;
      if (mounted.current && nextRead) void refresh(nextRead === "shop" ? undefined : nextRead);
    }
  }, [apply, preview, remember, refresh]);
  const buyKuji = useCallback((input: KujiPurchaseInput) => purchase({ kind: "kuji", input }, async () => {
    const engine = syncPreview();
    return engine ? engine.buyKuji(input) : api.buyKuji(input);
  }), [purchase, syncPreview]);
  const buyLotto = useCallback((input: LottoPurchaseInput) => purchase({ kind: "lotto", input }, async () => {
    const engine = syncPreview();
    return engine ? engine.buyLotto(input) : api.buyLotto(input);
  }), [purchase, syncPreview]);
  const buySpeetto = useCallback((input: SpeettoPurchaseInput) => purchase({ kind: "speetto", input }, async () => {
    const engine = syncPreview();
    return engine ? engine.buySpeetto(input) : api.buySpeetto(input);
  }), [purchase, syncPreview]);
  const spinSlot = useCallback((input: SlotSpinInput) => purchase({ kind: "slot", input }, async () => {
    const engine = syncPreview();
    return engine ? engine.spinSlot(input) : api.spinSlot(input);
  }), [purchase, syncPreview]);
  const drawTag = useCallback((input: TagDrawInput) => purchase({ kind: "tag", input }, async () => {
    const engine = syncPreview();
    return engine ? engine.drawTag(input) : api.drawTag(input);
  }), [purchase, syncPreview]);
  const equipTag = useCallback(async (tagId: string | null) => {
    if (writeInFlight.current || pendingRef.current) throw new Error("진행 중인 구매 결과를 먼저 확인해 주세요.");
    generation.current++;
    writeInFlight.current = true;
    setError("");
    try {
      const engine = syncPreview();
      const next = await callbacks.current.transact(async () => engine ? engine.equipTag(tagId) : api.equipTag(tagId));
      apply(next);
      return next;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "별명 태그를 바꾸지 못했어요.");
      throw e;
    } finally { writeInFlight.current = false; }
  }, [apply, syncPreview]);
  const claimPreviewLaunchGift = useCallback(() => {
    const engine = syncPreview();
    if (!engine) throw new Error("미리보기에서만 사용할 수 있어요.");
    if (writeInFlight.current || pendingRef.current) throw new Error("진행 중인 구매 결과를 먼저 확인해 주세요.");
    generation.current++;
    const result = engine.claimLaunchGift();
    apply(result.state);
    return { inventory: result.state.inventory, awarded: result.awarded };
  }, [syncPreview, apply]);
  return <ShopContext.Provider value={{ ...state, kuji, lotto, speetto, slot, tags, loading, error, pending, refresh, buyKuji, buyLotto, buySpeetto, spinSlot, drawTag, equipTag, claimPreviewLaunchGift }}>{children}</ShopContext.Provider>;
}
