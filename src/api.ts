import type {
  ApiError,
  AuthResponse,
  BootstrapResponse,
  GameId,
  GameResponse,
  HistoryResponse,
  AttendanceState,
  AttendanceClaimResponse,
  ShopState, KujiResponse, KujiPurchaseInput, LottoResponse, LottoPurchaseInput,
  SpeettoResponse, SpeettoPurchaseInput, SlotResponse, SlotSpinInput,
  CatchmindAction, CatchmindInput, CatchmindResponse, CatchmindPollResponse, CatchmindGalleryResponse,
  ClawResponse, ClawPlayInput, ClawCoinInput, FreeThrowSetInput, FreeThrowFinishInput, FreeThrowFinishResponse, FreeThrowState,
  ArcadeFinishInput, ArcadeFinishResponse, ArcadeStartInput, ArcadeState, BingoAction, BingoCreateInput, BingoInput, BingoPollResponse, BingoResponse, ToiletAction, ToiletPollResponse, ToiletPushInput, ToiletResponse,
  SantaFinishInput, SantaFinishResponse, SantaRunInput, SantaState,
  LaunchGiftResponse, LuckPhotoResponse, PasswordChangeInput, RankingResponse, TagDrawInput, TagEvolveInput, TagResponse, NotificationsResponse, NotificationSummary,
  AchievementsResponse, AchievementClaimInput, AchievementEventInput } from "../shared/types";
import type { NoticesReadResponse } from "../shared/notices";
import type { ArcadeGame } from "../shared/balance";
import type { RankingPeriod } from "../shared/ranking-periods";
import type { RankResult, RankResultKey } from "../shared/ranking-rewards";
import type { StockDetailView, StockMarketView, StockNewsPage, StockTradeInput, StockTradeResponse, StockUnchanged } from "../shared/stock-types";
import type { ArtKey } from "../shared/characters";
import type { AdminState, AdminClawConfig, PredictionRules } from "../shared/admin";

export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
/** The request never left this device (it was offline), so nothing was saved. */
export const notSent = (error: unknown): boolean => error instanceof ApiFailure && error.code === "OFFLINE";
/** The server evaluated the request and refused it: nothing was saved. A lost
 * response, a server error or a missing session (the request may have been
 * saved before the session ended) proves nothing, so a write that can be asked
 * again by its request id is kept until one of these answers. */
export const refusedByServer = (error: unknown): boolean =>
  error instanceof ApiFailure && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!navigator.onLine)
    throw new ApiFailure(
      0,
      "인터넷 연결을 확인해 주세요. 입력한 내용은 아직 저장되지 않았어요.",
      "OFFLINE",
    );
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiFailure(0, "연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiFailure(
      response.status,
      (body as ApiError | null)?.error?.message ??
        "요청을 처리하지 못했어요. 다시 시도해 주세요.",
      (body as ApiError | null)?.error?.code,
    );
  return body as T;
}
/** Opens a bingo game. The server answers in lines while the AI writes the
 * words: `onProgress(words, of)` is called as they arrive, then the board (or
 * the refusal) comes last. */
async function bingoCreate(input: BingoCreateInput, onProgress: (words: number, of: number) => void): Promise<BingoResponse> {
  if (!navigator.onLine) throw new ApiFailure(0, "인터넷 연결을 확인해 주세요. 입력한 내용은 아직 저장되지 않았어요.", "OFFLINE");
  let response: Response;
  try {
    response = await fetch("/api/bingo/create?stream=1", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  } catch { throw new ApiFailure(0, "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.", "NETWORK"); }
  if (!response.ok || !response.body || !response.headers.get("Content-Type")?.includes("ndjson")) {
    const body = await response.json().catch(() => null) as (ApiError & BingoResponse) | null;
    if (response.ok && body?.bingo) return body;
    throw new ApiFailure(response.status, body?.error?.message ?? "요청을 처리하지 못했어요. 다시 시도해 주세요.", body?.error?.code);
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", done: BingoResponse | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { progress?: number; of?: number; done?: BingoResponse; error?: { status: number; code: string; message: string } };
    if (message.error) throw new ApiFailure(message.error.status, message.error.message, message.error.code);
    if (message.done) done = message.done;
    else if (typeof message.progress === "number") onProgress(message.progress, message.of ?? 30);
  };
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { throw new ApiFailure(0, "응답이 끊겼어요. 빙고판을 다시 확인해 주세요.", "NETWORK"); }
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) take(line);
    if (chunk.done) break;
  }
  take(buffer);
  if (!done) throw new ApiFailure(0, "응답이 끊겼어요. 빙고판을 다시 확인해 주세요.", "NETWORK");
  return done;
}
export const api = {
  admin: () => request<AdminState>("/admin"),
  saveGameSettings: (id: GameId, rules: PredictionRules, effectiveFrom: string, expectedUserId: string) => request<AdminState>(`/admin/games/${id}`, {
    method: "PUT", body: JSON.stringify({ rules, effectiveFrom, expectedUserId }),
  }),
  saveClawSettings: (config: AdminClawConfig, expectedUserId: string) => request<AdminState>("/admin/claw", {
    method: "PUT", body: JSON.stringify({ ...config, expectedUserId }),
  }),
  updateProfile: (displayName: string, expectedUserId: string) => request<AuthResponse>("/me/profile", { method: "PUT", body: JSON.stringify({ displayName, expectedUserId }) }),
  uploadProfilePhoto: (photo: string, expectedUserId: string) => request<AuthResponse>("/me/photo", { method: "PUT", body: JSON.stringify({ photo, expectedUserId }) }),
  deleteProfilePhoto: (expectedUserId: string) => request<AuthResponse>("/me/photo", { method: "DELETE", body: JSON.stringify({ expectedUserId }) }),
  uploadLuckPhoto: (roundDate: string, image: string) => request<LuckPhotoResponse>("/games/luck/photo", { method: "PUT", body: JSON.stringify({ roundDate, image }) }),
  launchGift: () => request<LaunchGiftResponse>("/events/launch-gift", { method: "POST", body: "{}" }),
  rankResultsSeen: (results: RankResultKey[]) => request<{ results: RankResult[] }>("/ranking/results/seen", { method: "POST", body: JSON.stringify({ results: results.map(({ period, key }) => ({ period, key })) }) }),
  claw: () => request<ClawResponse>("/claw"),
  buyClawCoins: (input: ClawCoinInput) => request<ClawResponse>("/claw/coins", { method: "POST", body: JSON.stringify(input) }),
  playClaw: (input: ClawPlayInput) => request<ClawResponse>("/claw/play", { method: "POST", body: JSON.stringify(input) }),
  freeThrow: () => request<FreeThrowState>("/freethrow"),
  startFreeThrowSet: (input: FreeThrowSetInput) => request<FreeThrowState>("/freethrow/sets", { method: "POST", body: JSON.stringify(input) }),
  finishFreeThrowSet: (input: FreeThrowFinishInput) => request<FreeThrowFinishResponse>("/freethrow/finish", { method: "POST", body: JSON.stringify(input) }),
  arcade: (game: ArcadeGame) => request<ArcadeState>(`/arcade/${game}`),
  startArcadeSet: (game: ArcadeGame, input: ArcadeStartInput) => request<ArcadeState>(`/arcade/${game}/sets`, { method: "POST", body: JSON.stringify(input) }),
  finishArcadeSet: (game: ArcadeGame, input: ArcadeFinishInput) => request<ArcadeFinishResponse>(`/arcade/${game}/finish`, { method: "POST", body: JSON.stringify(input) }),
  santa: () => request<SantaState>("/santa"),
  startSantaRun: (input: SantaRunInput) => request<SantaState>("/santa/runs", { method: "POST", body: JSON.stringify(input) }),
  finishSantaRun: (input: SantaFinishInput) => request<SantaFinishResponse>("/santa/finish", { method: "POST", body: JSON.stringify(input) }),
  bingo: (since?: number) => request<BingoPollResponse>(`/bingo${since === undefined ? "" : `?since=${since}`}`),
  bingoCreate,
  bingoAction: (action: BingoAction, input: BingoInput) => request<BingoResponse>(`/bingo/${action}`, { method: "POST", body: JSON.stringify(input) }),
  toilet: (since?: string) => request<ToiletPollResponse>(`/toilet${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`),
  toiletAction: (action: ToiletAction, input: ToiletPushInput) => request<ToiletResponse>(`/toilet/${action}`, { method: "POST", body: JSON.stringify(input) }),
  catchmind: (since?: number) => request<CatchmindPollResponse>(`/catchmind${since === undefined ? "" : `?since=${since}`}`),
  catchmindGallery: (before?: number) => request<CatchmindGalleryResponse>(`/catchmind/gallery${before === undefined ? "" : `?before=${before}`}`),
  catchmindAction: (action: CatchmindAction, input: CatchmindInput) => request<CatchmindResponse>(`/catchmind/${action}`, { method: "POST", body: JSON.stringify(input) }),
  attendance: (month: string) => request<{ attendance: AttendanceState }>(`/me/attendance?month=${encodeURIComponent(month)}`),
  claimAttendance: () => request<AttendanceClaimResponse>("/me/attendance", { method: "POST", body: "{}" }),
  character: (character: ArtKey, migrate = false, expectedUserId?: string) => request<AuthResponse>("/me/character", {
    method: "PUT", body: JSON.stringify({ character, migrate, ...(migrate ? { expectedUserId } : {}) }),
  }),
  shop: () => request<ShopState>("/shop"),
  kuji: () => request<KujiResponse>("/shop/kuji"),
  lotto: () => request<LottoResponse>("/shop/lotto"),
  speetto: () => request<SpeettoResponse>("/shop/speetto"),
  slot: () => request<SlotResponse>("/shop/slot"),
  tag: () => request<TagResponse>("/shop/tag"),
  buyKuji: (input: KujiPurchaseInput) => request<KujiResponse>("/shop/kuji", { method: "POST", body: JSON.stringify(input) }),
  buyLotto: (input: LottoPurchaseInput) => request<LottoResponse>("/shop/lotto", { method: "POST", body: JSON.stringify(input) }),
  buySpeetto: (input: SpeettoPurchaseInput) => request<SpeettoResponse>("/shop/speetto", { method: "POST", body: JSON.stringify(input) }),
  spinSlot: (input: SlotSpinInput) => request<SlotResponse>("/shop/slot", { method: "POST", body: JSON.stringify(input) }),
  drawTag: (input: TagDrawInput) => request<TagResponse>("/shop/tag", { method: "POST", body: JSON.stringify(input) }),
  equipTag: (tagId: string | null) => request<TagResponse>("/me/nickname-tag", { method: "PUT", body: JSON.stringify({ tagId }) }),
  discardTag: (tagId: string) => request<TagResponse>("/me/nickname-tag/discard", { method: "POST", body: JSON.stringify({ tagId }) }),
  evolveTag: (input: TagEvolveInput) => request<TagResponse>("/me/nickname-tag/evolve", { method: "POST", body: JSON.stringify(input) }),
  revealSpeetto: (ticketId: string) => request<SpeettoResponse>("/shop/speetto/reveal", { method: "POST", body: JSON.stringify({ ticketId }) }),
  stock: (since?: string) => request<StockMarketView | StockUnchanged>(`/stock${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  stockDetail: (ticker: string) => request<StockDetailView>(`/stock/${ticker}`),
  stockNews: (before?: string) => request<StockNewsPage>(`/stock/news${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  tradeStock: (input: StockTradeInput) => request<StockTradeResponse>("/stock/trade", { method: "POST", body: JSON.stringify(input) }),
  addMarketHoliday: (date: string, reason: string, expectedUserId: string) => request<AdminState>("/admin/market-holidays", { method: "POST", body: JSON.stringify({ date, reason, expectedUserId }) }),
  sendNotice: (notice: { title: string; body: string }) =>
    request<NotificationSummary>("/admin/notifications", { method: "POST", body: JSON.stringify(notice) }),
  setStockAi: (setting: { enabled?: boolean; provider?: "anthropic" | "openai" }) => request<AdminState>("/admin/stock/ai", { method: "PUT", body: JSON.stringify(setting) }),
  setStockNewsHidden: (id: string, hidden: boolean) => request<AdminState>(`/admin/stock/news/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ hidden }) }),
  removeMarketHoliday: (date: string) => request<AdminState>(`/admin/market-holidays/${date}`, { method: "DELETE" }),
  history: (id: GameId) => request<HistoryResponse>(`/games/${id}/history`),
  wake: (roundDate: string) => request<GameResponse>("/games/wake/wake", {
    method: "POST",
    body: JSON.stringify({ roundDate }),
  }),
  bootstrap: () => request<BootstrapResponse>("/bootstrap"),
  achievements: () => request<AchievementsResponse>("/achievements"),
  claimAchievement: (input: AchievementClaimInput) => request<AchievementsResponse>("/achievements/claim", { method: "POST", body: JSON.stringify(input) }),
  achievementEvent: (input: AchievementEventInput) => request<AchievementsResponse>("/achievements/events", { method: "POST", body: JSON.stringify(input) }),
  readNotices: (ids: string[]) =>
    request<NoticesReadResponse>("/notices/read", { method: "POST", body: JSON.stringify({ ids }) }),
  notifications: (before?: string) =>
    request<NotificationsResponse>(`/notifications${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  ranking: (period: RankingPeriod, before?: string) => request<RankingResponse>(`/ranking?period=${period}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  changePassword: (input: PasswordChangeInput) => request<{ ok: true }>("/me/password", {
    method: "PUT", body: JSON.stringify(input),
  }),
  login: (username: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  predict: (id: GameId, value: string, roundDate: string) =>
    request<GameResponse>(`/games/${id}/prediction`, {
      method: "PUT",
      body: JSON.stringify({ value, roundDate }),
    }),
  answer: (id: GameId, value: string, hint: string, roundDate: string) =>
    request<GameResponse>(`/games/${id}/answer`, {
      method: "PUT",
      body: JSON.stringify({ value, hint, roundDate }),
    }),
  reveal: (id: GameId, roundDate: string) =>
    request<GameResponse>(`/games/${id}/reveal`, {
      method: "POST",
      body: JSON.stringify({ roundDate }),
    }),
};
